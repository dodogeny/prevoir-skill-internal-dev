'use strict';

// Health monitor — runs as a worker_threads thread inside prevoyant-server.
// Polls /health every intervalSecs seconds.  After failThreshold consecutive
// failures it sends an urgent email alert.  Sends a recovery email when the
// server comes back up.  On a graceful-stop message from the main thread it
// exits without alerting (intentional restarts / stops are not incidents).

const { workerData, parentPort } = require('worker_threads');
const http = require('http');
const net  = require('net');
const tls  = require('tls');

const {
  port          = 3000,
  intervalSecs  = 60,
  failThreshold = 3,
  smtpHost      = '',
  smtpPort      = '587',
  smtpUser      = '',
  smtpPass      = '',
  emailTo       = '',
} = workerData || {};

let consecutive   = 0;
let serverWasDown = false;
let halted        = false;   // set on graceful-stop to suppress false alerts
const startedAt   = new Date().toUTCString();

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  // Also print to stdout so it lands in prevoyant-server.log
  console.log(`[watchdog/${level}] ${msg}`);
}

// ── SMTP client (no external deps, supports port 587 STARTTLS + 465 SSL) ─────

function sendEmail(subject, body) {
  if (!smtpHost || !smtpUser || !smtpPass || !emailTo) {
    log('warn', 'Email alert skipped — SMTP not fully configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock      = null;       // underlying net socket (plain phase)
    let active    = null;       // current writable: net or tls socket
    let buf       = '';
    let phase     = 'greeting';
    let settled   = false;

    function done(err) {
      if (settled) return;
      settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve();
    }

    function write(s) { active.write(s + '\r\n'); }

    function handle(code, msg) { // eslint-disable-line no-unused-vars
      switch (phase) {
        case 'greeting':
          if (code !== 220) return done(new Error(`Unexpected greeting ${code}`));
          phase = 'ehlo1';
          write('EHLO prevoyant-watchdog');
          break;

        case 'ehlo1':
          if (code === 250) {
            if (USE_SSL) { phase = 'auth';     write('AUTH LOGIN'); }
            else         { phase = 'starttls'; write('STARTTLS');   }
          }
          break;

        case 'starttls':
          if (code !== 220) return done(new Error(`STARTTLS rejected: ${code}`));
          phase = 'ehlo2';
          {
            const upgraded = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
            upgraded.on('secureConnect', () => { active = upgraded; write('EHLO prevoyant-watchdog'); });
            upgraded.on('data', onData);
            upgraded.on('error', done);
          }
          break;

        case 'ehlo2':
          if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); }
          break;

        case 'auth':
          if (code !== 334) return done(new Error(`AUTH rejected: ${code}`));
          phase = 'user';
          write(Buffer.from(smtpUser).toString('base64'));
          break;

        case 'user':
          if (code !== 334) return done(new Error(`AUTH username rejected: ${code}`));
          phase = 'pass';
          write(Buffer.from(smtpPass).toString('base64'));
          break;

        case 'pass':
          if (code !== 235) return done(new Error(`AUTH failed: ${code}`));
          phase = 'mail';
          write(`MAIL FROM:<${smtpUser}>`);
          break;

        case 'mail':
          if (code !== 250) return done(new Error(`MAIL FROM rejected: ${code}`));
          phase = 'rcpt';
          write(`RCPT TO:<${emailTo}>`);
          break;

        case 'rcpt':
          if (code !== 250) return done(new Error(`RCPT TO rejected: ${code}`));
          phase = 'data';
          write('DATA');
          break;

        case 'data':
          if (code !== 354) return done(new Error(`DATA rejected: ${code}`));
          phase = 'body';
          write(`From: Prevoyant Watchdog <${smtpUser}>`);
          write(`To: ${emailTo}`);
          write(`Subject: ${subject}`);
          write(`Date: ${new Date().toUTCString()}`);
          write('MIME-Version: 1.0');
          write('Content-Type: text/plain; charset=utf-8');
          write('');
          // Dot-stuffing: lines starting with "." must be prefixed with another "."
          for (const line of body.split('\n')) {
            write(line.startsWith('.') ? '.' + line : line);
          }
          write('.');
          break;

        case 'body':
          if (code !== 250) return done(new Error(`Message rejected: ${code}`));
          phase = 'quit';
          write('QUIT');
          break;

        case 'quit':
          done(null);
          break;

        default:
          break;
      }
    }

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const cont = line[3] === '-'; // multi-line response continuation
        if (!cont && !isNaN(code)) handle(code, line.slice(4));
      }
    }

    const connectOpts = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock   = USE_SSL ? tls.connect(connectOpts) : net.connect(connectOpts);
    active = sock;
    sock.on('data', onData);
    sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP connect timeout')));
  });
}

// ── Health check ──────────────────────────────────────────────────────────────

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Alert builders ────────────────────────────────────────────────────────────

function downAlert() {
  const subject = '[Prevoyant] URGENT — Server is DOWN';
  const body = [
    'Prevoyant Server has stopped responding to health checks.',
    '',
    `  Health endpoint : http://127.0.0.1:${port}/health`,
    `  Failed checks   : ${consecutive} consecutive (threshold: ${failThreshold})`,
    `  Detected at     : ${new Date().toUTCString()}`,
    `  Monitor started : ${startedAt}`,
    '',
    'Action required: check server logs and restart if necessary.',
    '',
    '  cd prevoyant-server',
    '  bash scripts/start.sh',
    '  tail -f prevoyant-server.log',
  ].join('\n');
  return { subject, body };
}

function recoveryAlert() {
  const subject = '[Prevoyant] Server recovered';
  const body = [
    'Prevoyant Server is back online and responding normally.',
    '',
    `  Health endpoint : http://127.0.0.1:${port}/health`,
    `  Recovered at    : ${new Date().toUTCString()}`,
  ].join('\n');
  return { subject, body };
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick() {
  if (halted) return;

  const ok = await checkHealth();

  if (!ok) {
    consecutive++;
    log('warn', `Health check failed (${consecutive}/${failThreshold})`);
    if (parentPort) parentPort.postMessage({ type: 'status', ok: false, consecutive, failThreshold });

    if (consecutive >= failThreshold && !serverWasDown) {
      serverWasDown = true;
      const { subject, body } = downAlert();
      log('error', `Sending DOWN alert to ${emailTo}`);
      await sendEmail(subject, body).catch(e => log('error', `Alert send failed: ${e.message}`));
    }
  } else {
    if (serverWasDown) {
      serverWasDown = false;
      consecutive   = 0;
      const { subject, body } = recoveryAlert();
      log('info', `Server recovered — sending recovery alert to ${emailTo}`);
      await sendEmail(subject, body).catch(e => log('error', `Recovery alert failed: ${e.message}`));
    } else {
      consecutive = 0;
    }
    if (parentPort) parentPort.postMessage({ type: 'status', ok: true, consecutive: 0 });
  }
}

// ── Messages from main thread ─────────────────────────────────────────────────
// Main thread sends { type: 'graceful-stop' } before planned shutdowns so the
// watchdog does not fire a false DOWN alert for intentional restarts / stops.

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg && msg.type === 'graceful-stop') {
      halted = true;
      log('info', 'Graceful-stop signal received — monitoring halted (no alert will be sent)');
      // Give any in-flight tick a moment to finish before exiting
      setTimeout(() => process.exit(0), 500);
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

log('info', `Started — polling http://127.0.0.1:${port}/health every ${intervalSecs}s, alert after ${failThreshold} consecutive failures`);
tick();
setInterval(tick, intervalSecs * 1000);
