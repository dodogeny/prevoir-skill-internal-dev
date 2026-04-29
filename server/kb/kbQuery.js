'use strict';

const path    = require('path');
const kbCache = require('./kbCache');

// Resolve the schema once; it lives next to the plugin personas.
const SCHEMA_PATH = path.resolve(__dirname, '../../plugin/config/kb-schema.json');

let _schema = null;
function loadSchema() {
  if (!_schema) _schema = JSON.parse(require('fs').readFileSync(SCHEMA_PATH, 'utf8'));
  return _schema;
}

// ── Block builder ─────────────────────────────────────────────────────────────

/**
 * Build the KB pre-load block to prepend to the Claude prompt.
 *
 * @param {object} opts
 * @param {string}   opts.ticketKey
 * @param {string[]} [opts.components]  from Jira webhook payload
 * @param {string[]} [opts.labels]      from Jira webhook payload
 * @param {string}   [opts.summary]     from Jira webhook payload
 * @returns {string|null}  Block string with sentinel, or null if KB unavailable.
 */
function buildPriorKnowledgeBlock({ ticketKey, components = [], labels = [], summary = '' }) {
  try {
    if (kbCache.isEncrypted()) return null;

    const schema  = loadSchema();
    const { layers } = schema;
    const cache   = kbCache.get();

    if (!Object.keys(cache).length) return null;

    const lines = [];

    // ── Sentinel ───────────────────────────────────────────────────────────────
    lines.push(`<!-- KB_PRELOADED schemaVersion=${schema.schemaVersion} -->`);
    lines.push('');
    lines.push('## Knowledge Base — Pre-loaded Context');
    lines.push('');
    lines.push(`**Ticket:** ${ticketKey}`);
    if (components.length) lines.push(`**Components (webhook):** ${components.join(', ')}`);
    if (labels.length)     lines.push(`**Labels (webhook):** ${labels.join(', ')}`);
    if (summary)           lines.push(`**Summary (webhook):** ${summary}`);
    lines.push('');
    lines.push('> Server pre-loaded all KB files below. Use these for Step 0b query logic');
    lines.push('> (room matching, trigger scanning, Prior Knowledge block) — no file reads needed.');
    lines.push('');

    // ── INDEX.md ───────────────────────────────────────────────────────────────
    const indexContent = cache[layers.index];
    if (indexContent) {
      lines.push('---');
      lines.push(`### ${layers.index}`);
      lines.push('');
      lines.push(indexContent.trim());
      lines.push('');
    }

    // ── Shared knowledge ───────────────────────────────────────────────────────
    const sharedFiles = Object.keys(cache)
      .filter(k => k.startsWith(layers.shared + '/') && k.endsWith('.md'))
      .sort();

    if (sharedFiles.length) {
      lines.push('---');
      lines.push('### Shared Knowledge');
      lines.push('');
      for (const rel of sharedFiles) {
        lines.push(`#### ${rel}`);
        lines.push('');
        lines.push(cache[rel].trim());
        lines.push('');
      }
    }

    // ── Core Mental Map ────────────────────────────────────────────────────────
    const cmmFiles = Object.keys(cache)
      .filter(k => k.startsWith(layers.coreMetalMap + '/') && k.endsWith('.md'))
      .sort();

    if (cmmFiles.length) {
      lines.push('---');
      lines.push('### Core Mental Map');
      lines.push('');
      for (const rel of cmmFiles) {
        lines.push(`#### ${rel}`);
        lines.push('');
        lines.push(cache[rel].trim());
        lines.push('');
      }
    }

    // ── Lessons Learned ────────────────────────────────────────────────────────
    const llFiles = Object.keys(cache)
      .filter(k => k.startsWith(layers.lessonsLearned + '/') && k.endsWith('.md'))
      .sort();

    if (llFiles.length) {
      lines.push('---');
      lines.push('### Lessons Learned');
      lines.push('');
      for (const rel of llFiles) {
        lines.push(`#### ${rel}`);
        lines.push('');
        lines.push(cache[rel].trim());
        lines.push('');
      }
    }

    // ── Agent Personal Memory ──────────────────────────────────────────────────
    lines.push('---');
    lines.push('### Agent Personal Memory');
    lines.push('');

    for (const agent of layers.agents) {
      const prefix   = `${layers.personaMemory}/${agent}/`;
      const memFiles = Object.keys(cache)
        .filter(k => k.startsWith(prefix) && k.endsWith('.md'))
        .sort()
        .slice(-5); // 5 most recent (YYYYMMDD-TICKET.md sorts chronologically)

      if (!memFiles.length) {
        lines.push(`#### ${agent} — 0 sessions (first session)`);
        lines.push('');
        continue;
      }

      lines.push(`#### ${agent} — ${memFiles.length} session(s) loaded`);
      lines.push('');
      for (const rel of memFiles) {
        lines.push(`**${path.basename(rel)}**`);
        lines.push('');
        // Trim each memory file to first 20 lines to keep block size reasonable.
        const excerpt = cache[rel].trim().split('\n').slice(0, 20).join('\n');
        lines.push(excerpt);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('<!-- KB_PRELOADED_END -->');
    lines.push('');

    return lines.join('\n');

  } catch (err) {
    console.warn(`[kb-query] buildPriorKnowledgeBlock failed — skipping pre-load: ${err.message}`);
    return null;
  }
}

module.exports = { buildPriorKnowledgeBlock };
