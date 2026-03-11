import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { config as dotenvConfig } from 'dotenv';

// ── Load .env ──
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

// ── Direct API Keys ──
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
let OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
let SELECTED_MODEL = '';

// Model name mapping: OpenClaw/OpenRouter format → Anthropic API format
const MODEL_MAP = {
  'anthropic/claude-opus-4-6':    'claude-opus-4-6-20250626',
  'anthropic/claude-opus-4-5':    'claude-opus-4-5-20250414',
  'anthropic/claude-sonnet-4-5':  'claude-sonnet-4-5-20250514',
  'anthropic/claude-sonnet-4':    'claude-sonnet-4-20250514',
  'anthropic/claude-3-5-sonnet':  'claude-3-5-sonnet-20241022',
  'anthropic/claude-3-5-haiku':   'claude-3-5-haiku-20241022',
  'anthropic/claude-4-haiku':     'claude-4-haiku-20250414',
};

function mapModel(model) {
  // If already in Anthropic format (starts with "claude-"), use as-is
  if (model.startsWith('claude-')) return model;
  // Try mapped name
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  // Strip provider prefix and try
  const stripped = model.replace(/^anthropic\//, '');
  if (MODEL_MAP[`anthropic/${stripped}`]) return MODEL_MAP[`anthropic/${stripped}`];
  // Last resort: strip prefix, add date suffix guess
  return stripped;
}

// Detect provider from model name
function detectProvider(model) {
  if (!model) return 'anthropic';
  const m = model.toLowerCase().replace(/^(anthropic|openai)\//, '');
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('chatgpt')) return 'openai';
  // If an OpenAI key is set but not Anthropic, assume OpenAI
  if (OPENAI_API_KEY && !ANTHROPIC_API_KEY) return 'openai';
  return 'anthropic';
}

// ── Paths ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8099', 10);
let GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:18789';

// ── System Paths ──
const HOME = homedir();
const DATA_DIR = join(__dirname, 'data');
const THREADS_DIR = join(DATA_DIR, 'threads');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(HOME, '.openclaw');
const CLAUDE_SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || join(HOME, '.claude', 'settings.json');
let USER_NAME = process.env.VEKTOR_USER_NAME || 'User';
const ARCHIVE_DIR = process.env.VEKTOR_ARCHIVE_DIR || join(DATA_DIR, 'archive');
const CROSS_AGENT_CONTEXT_PATH = process.env.VEKTOR_CROSS_AGENT_CONTEXT || join(DATA_DIR, 'memory', 'cross-agent-context.md');

// Session directories (per agent)
const AGENTS_DIR = join(OPENCLAW_DIR, 'agents');

// ── Per-Agent Configuration (loaded from agents.json) ──
const DEFAULT_AGENT = {
  id: 'main', name: 'Agent', glyph: '\u23C0',
  accent: '#8EC3E3', accentDim: '#6A9DBD', accentGlow: 'rgba(142,195,227,0.08)',
};

function loadAgentConfig() {
  const agentsJsonPath = join(__dirname, 'agents.json');
  try {
    if (existsSync(agentsJsonPath)) {
      const raw = JSON.parse(readFileSync(agentsJsonPath, 'utf-8'));
      // Support both array and object formats
      const agents = Array.isArray(raw) ? raw : (raw.agents || [raw]);
      const config = {};
      for (const agent of agents) {
        if (!agent.id) continue;
        config[agent.id] = {
          id: agent.id,
          name: agent.name || agent.id,
          glyph: agent.glyph || DEFAULT_AGENT.glyph,
          accent: agent.accent || DEFAULT_AGENT.accent,
          accentDim: agent.accentDim || DEFAULT_AGENT.accentDim,
          accentGlow: agent.accentGlow || DEFAULT_AGENT.accentGlow,
          workspace: agent.workspace || null,
          memoryFile: agent.memoryFile || null,
          memoryDir: agent.memoryDir || null,
          skillDirs: Array.isArray(agent.skillDirs)
            ? agent.skillDirs.map(d => typeof d === 'string' ? { path: d, source: 'custom' } : d)
            : [],
          journalPath: agent.journalPath || null,
        };
      }
      if (Object.keys(config).length > 0) return config;
    }
  } catch (err) {
    console.warn('[Config] Failed to load agents.json, using defaults:', err.message);
  }
  // Default: single agent
  return { [DEFAULT_AGENT.id]: { ...DEFAULT_AGENT, skillDirs: [] } };
}

let AGENT_CONFIG = loadAgentConfig();

// ── Runtime Config Persistence ──
const RUNTIME_CONFIG_PATH = join(DATA_DIR, 'config.json');

function loadRuntimeConfig() {
  try {
    if (existsSync(RUNTIME_CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
      if (cfg.gateway) GATEWAY = cfg.gateway;
      if (cfg.anthropicApiKey) ANTHROPIC_API_KEY = cfg.anthropicApiKey;
      if (cfg.openaiApiKey) OPENAI_API_KEY = cfg.openaiApiKey;
      if (cfg.openaiBaseUrl) OPENAI_BASE_URL = cfg.openaiBaseUrl;
      if (cfg.selectedModel) SELECTED_MODEL = cfg.selectedModel;
      if (cfg.userDisplayName) USER_NAME = cfg.userDisplayName;
      if (cfg.agents && Array.isArray(cfg.agents) && cfg.agents.length > 0) {
        const config = {};
        for (const agent of cfg.agents) {
          if (!agent.id) continue;
          config[agent.id] = {
            id: agent.id,
            name: agent.name || agent.id,
            glyph: agent.glyph || DEFAULT_AGENT.glyph,
            accent: agent.accent || DEFAULT_AGENT.accent,
            accentDim: agent.accentDim || DEFAULT_AGENT.accentDim,
            accentGlow: agent.accentGlow || DEFAULT_AGENT.accentGlow,
            workspace: agent.workspace || null,
            memoryFile: agent.memoryFile || null,
            memoryDir: agent.memoryDir || null,
            skillDirs: Array.isArray(agent.skillDirs)
              ? agent.skillDirs.map(d => typeof d === 'string' ? { path: d, source: 'custom' } : d)
              : [],
            journalPath: agent.journalPath || null,
          };
        }
        if (Object.keys(config).length > 0) AGENT_CONFIG = config;
      }
      console.log('[Config] Loaded runtime config from data/config.json');
    }
  } catch (err) {
    console.warn('[Config] Failed to load runtime config:', err.message);
  }
}

function saveRuntimeConfig() {
  const agents = Object.values(AGENT_CONFIG).map(a => ({
    id: a.id, name: a.name, glyph: a.glyph,
    accent: a.accent, accentDim: a.accentDim, accentGlow: a.accentGlow,
    workspace: a.workspace, memoryFile: a.memoryFile, memoryDir: a.memoryDir,
    skillDirs: a.skillDirs, journalPath: a.journalPath,
  }));
  const cfg = {
    gateway: GATEWAY,
    anthropicApiKey: ANTHROPIC_API_KEY,
    openaiApiKey: OPENAI_API_KEY,
    openaiBaseUrl: OPENAI_BASE_URL,
    selectedModel: SELECTED_MODEL,
    userDisplayName: USER_NAME,
    agents,
  };
  writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isFirstRun() {
  return !existsSync(RUNTIME_CONFIG_PATH)
    && !existsSync(join(__dirname, 'agents.json'))
    && !ANTHROPIC_API_KEY;
}

loadRuntimeConfig();

function getAgentConfig(agentId) {
  return AGENT_CONFIG[agentId] || AGENT_CONFIG[Object.keys(AGENT_CONFIG)[0]] || DEFAULT_AGENT;
}

// Ensure directories exist
[DATA_DIR, THREADS_DIR, UPLOADS_DIR, PUBLIC_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// ── Express App ──
const app = express();
const server = createServer(app);

// ── Middleware ──
// Skip body parsing for /v1/ proxy routes — we need the raw body
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  express.json({ limit: '50mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Skip noisy paths
    if (req.path === '/health' || req.path === '/favicon.ico') return;
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Rate limiting (simple in-memory, per-IP)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60; // 60 requests per minute for /v1/

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' }
    });
  }
  next();
}

// Clean up stale rate limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(ip);
  }
}, 300_000);

// ── Consistent Error Response ──
function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// GET /api/agents — return loaded agent configuration
app.get('/api/agents', (req, res) => {
  res.json(AGENT_CONFIG);
});

// GET /api/config — return public server configuration
app.get('/api/config', (req, res) => {
  res.json({ userDisplayName: USER_NAME, isFirstRun: isFirstRun() });
});

// ── Settings API ──

// GET /api/settings — return full settings for the settings panel
app.get('/api/settings', (req, res) => {
  const maskedAnthropicKey = ANTHROPIC_API_KEY
    ? '•'.repeat(Math.max(0, ANTHROPIC_API_KEY.length - 8)) + ANTHROPIC_API_KEY.slice(-8)
    : '';
  const maskedOpenaiKey = OPENAI_API_KEY
    ? '•'.repeat(Math.max(0, OPENAI_API_KEY.length - 8)) + OPENAI_API_KEY.slice(-8)
    : '';
  const agents = Object.values(AGENT_CONFIG).map(a => ({
    id: a.id, name: a.name, glyph: a.glyph,
    accent: a.accent, accentDim: a.accentDim, accentGlow: a.accentGlow,
    workspace: a.workspace || '', memoryFile: a.memoryFile || '', memoryDir: a.memoryDir || '',
    skillDirs: a.skillDirs || [], journalPath: a.journalPath || '',
  }));
  res.json({
    gateway: GATEWAY,
    anthropicApiKey: maskedAnthropicKey,
    openaiApiKey: maskedOpenaiKey,
    openaiBaseUrl: OPENAI_BASE_URL,
    selectedModel: SELECTED_MODEL,
    userDisplayName: USER_NAME,
    agents,
    isFirstRun: isFirstRun(),
  });
});

// PUT /api/settings — update settings, persist, broadcast
app.put('/api/settings', express.json(), (req, res) => {
  const body = req.body;
  if (body.gateway && typeof body.gateway === 'string') GATEWAY = body.gateway.trim();
  if (body.anthropicApiKey && body.anthropicApiKey !== '__unchanged__') {
    ANTHROPIC_API_KEY = body.anthropicApiKey.trim();
  }
  if (body.openaiApiKey && body.openaiApiKey !== '__unchanged__') {
    OPENAI_API_KEY = body.openaiApiKey.trim();
  }
  if (body.openaiBaseUrl !== undefined) {
    OPENAI_BASE_URL = (body.openaiBaseUrl || 'https://api.openai.com/v1').trim();
  }
  if (body.selectedModel !== undefined) {
    SELECTED_MODEL = (body.selectedModel || '').trim();
  }
  if (body.userDisplayName && typeof body.userDisplayName === 'string') {
    USER_NAME = body.userDisplayName.trim();
  }
  if (Array.isArray(body.agents)) {
    const config = {};
    for (const agent of body.agents) {
      if (!agent.id || typeof agent.id !== 'string') continue;
      const id = agent.id.trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) continue;
      config[id] = {
        id,
        name: agent.name || id,
        glyph: agent.glyph || DEFAULT_AGENT.glyph,
        accent: agent.accent || DEFAULT_AGENT.accent,
        accentDim: agent.accentDim || DEFAULT_AGENT.accentDim,
        accentGlow: agent.accentGlow || DEFAULT_AGENT.accentGlow,
        workspace: agent.workspace || null,
        memoryFile: agent.memoryFile || null,
        memoryDir: agent.memoryDir || null,
        skillDirs: Array.isArray(agent.skillDirs)
          ? agent.skillDirs.map(d => typeof d === 'string' ? { path: d, source: 'custom' } : d)
          : [],
        journalPath: agent.journalPath || null,
      };
    }
    if (Object.keys(config).length > 0) AGENT_CONFIG = config;
  }
  try {
    saveRuntimeConfig();
    // Broadcast to all WS clients
    wss.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'config-updated' }));
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/test-gateway — test gateway connectivity
app.post('/api/settings/test-gateway', express.json(), async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ reachable: false, error: 'No URL provided' });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    res.json({ reachable: r.ok, status: r.status });
  } catch (err) {
    res.json({ reachable: false, error: err.message });
  }
});

// POST /api/settings/test-api-key — validate Anthropic API key
app.post('/api/settings/test-api-key', express.json(), async (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ valid: false, error: 'No key provided' });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    clearTimeout(timeout);
    res.json({ valid: r.ok, status: r.status });
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// POST /api/settings/test-openai-key — validate OpenAI API key
app.post('/api/settings/test-openai-key', express.json(), async (req, res) => {
  const key = req.body.key;
  const baseUrl = (req.body.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!key) return res.status(400).json({ valid: false, error: 'No key provided' });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    clearTimeout(timeout);
    res.json({ valid: r.ok, status: r.status });
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});


// ══════════════════════════════════════════════
// 1. THREAD PERSISTENCE
// ══════════════════════════════════════════════

function threadPath(id) {
  return join(THREADS_DIR, `${id}.json`);
}

function readThread(id) {
  const fp = threadPath(id);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function toIsoTimestamp(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeServerMessage(message, fallbackTimestamp) {
  const timestamp = toIsoTimestamp(message?.timestamp, fallbackTimestamp);
  return {
    id: message?.id || uuidv4(),
    role: message?.role || 'assistant',
    content: typeof message?.content === 'string' ? message.content : '',
    timestamp,
    ...(message?.agentId ? { agentId: message.agentId } : {}),
    ...(typeof message?.thinkingText === 'string' && message.thinkingText.length > 0 ? { thinkingText: message.thinkingText } : {}),
    ...(Number.isFinite(message?.thinkingDuration) ? { thinkingDuration: message.thinkingDuration } : {}),
    ...(Array.isArray(message?.attachments) ? { attachments: message.attachments } : {})
  };
}

function normalizeThreadPayload(id, payload = {}, existing = null) {
  const nowIso = new Date().toISOString();
  const mode = payload.mode || existing?.mode || 'direct';
  const participants = Array.isArray(payload.participants) && payload.participants.length
    ? payload.participants
    : (Array.isArray(existing?.participants) && existing.participants.length
      ? existing.participants
      : [payload.agentId || existing?.agentId || 'main']);
  const agentId = payload.agentId
    || existing?.agentId
    || (mode === 'direct' ? (participants[0] || 'main') : null);
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : (existing?.messages || []);
  const messages = rawMessages.map((message, index) =>
    normalizeServerMessage(message, toIsoTimestamp(message?.timestamp, rawMessages[index - 1]?.timestamp || nowIso))
  );
  const lastMessageTimestamp = messages[messages.length - 1]?.timestamp || null;

  return {
    id,
    name: payload.name || existing?.name || `Thread ${Date.now()}`,
    mode,
    ...(agentId ? { agentId } : {}),
    participants,
    sessionKey: payload.sessionKey || existing?.sessionKey || `vektor:${id}`,
    createdAt: toIsoTimestamp(payload.createdAt || payload.created || existing?.createdAt, nowIso),
    updatedAt: toIsoTimestamp(payload.updatedAt || lastMessageTimestamp || existing?.updatedAt, nowIso),
    ...(payload.sourceThreadId || existing?.sourceThreadId ? { sourceThreadId: payload.sourceThreadId || existing?.sourceThreadId } : {}),
    ...(payload.sourceThreadTitle || existing?.sourceThreadTitle ? { sourceThreadTitle: payload.sourceThreadTitle || existing?.sourceThreadTitle } : {}),
    ...(payload.resumeSummary || existing?.resumeSummary ? { resumeSummary: payload.resumeSummary || existing?.resumeSummary } : {}),
    ...(payload.resumeGeneratedAt || existing?.resumeGeneratedAt ? { resumeGeneratedAt: toIsoTimestamp(payload.resumeGeneratedAt || existing?.resumeGeneratedAt, nowIso) } : {}),
    ...(payload.lastArchivedAt || existing?.lastArchivedAt ? { lastArchivedAt: toIsoTimestamp(payload.lastArchivedAt || existing?.lastArchivedAt, nowIso) } : {}),
    messages
  };
}

function writeThread(thread) {
  thread.updatedAt = new Date().toISOString();
  writeFileSync(threadPath(thread.id), JSON.stringify(thread, null, 2), 'utf-8');
  return thread;
}

function listThreads() {
  const files = readdirSync(THREADS_DIR).filter(f => f.endsWith('.json'));
  const threads = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(THREADS_DIR, file), 'utf-8'));
      threads.push({
        id: data.id,
        name: data.name,
        mode: data.mode || 'direct',
        agentId: data.agentId || null,
      participants: data.participants || ['main'],
      updatedAt: data.updatedAt,
      createdAt: data.createdAt,
      lastArchivedAt: data.lastArchivedAt || null,
      messageCount: (data.messages || []).length,
      sessionKey: data.sessionKey || null
    });
    } catch { /* skip corrupted files */ }
  }
  // Sort by updatedAt descending
  threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return threads;
}

function deleteThreadFile(id) {
  const fp = threadPath(id);
  if (existsSync(fp)) unlinkSync(fp);
}

// GET /api/threads — list all threads
app.get('/api/threads', (req, res) => {
  try {
    const threads = listThreads();
    res.json({ threads });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/threads/:id — get full thread with messages
app.get('/api/threads/:id', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');
  res.json(thread);
});

// POST /api/threads — create new thread
app.post('/api/threads', async (req, res) => {
  try {
    const { id: clientId, name, mode, participants, agentId } = req.body;
    // Accept client-specified ID if provided (for sync), otherwise generate
    const id = clientId || ('thread_' + Date.now() + '_' + uuidv4().slice(0, 8));
    // If thread already exists, just return it (idempotent create)
    const existing = readThread(id);
    if (existing) return res.status(200).json(existing);
    const sessionKey = `vektor:${id}`;
    const now = new Date().toISOString();

    const thread = {
      id,
      name: name || `Thread ${Date.now()}`,
      mode: mode || 'direct',
      ...(agentId ? { agentId } : {}),
      participants: participants || [agentId || 'main'],
      sessionKey,
      createdAt: now,
      updatedAt: now,
      messages: []
    };

    writeThread(thread);

    // Broadcast to WebSocket clients
    wsBroadcast({ type: 'thread_created', thread: { id, name: thread.name, sessionKey } });

    res.status(201).json(thread);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// PUT /api/threads/:id/snapshot — replace or create a full thread snapshot
app.put('/api/threads/:id/snapshot', (req, res) => {
  try {
    const existing = readThread(req.params.id);
    const thread = normalizeThreadPayload(req.params.id, req.body || {}, existing);
    writeThread(thread);

    if (existing) {
      wsBroadcast({ type: 'thread_updated', threadId: thread.id, name: thread.name });
    } else {
      wsBroadcast({ type: 'thread_created', thread: { id: thread.id, name: thread.name, sessionKey: thread.sessionKey } });
    }

    res.status(existing ? 200 : 201).json(thread);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// PATCH /api/threads/:id — update thread metadata
app.patch('/api/threads/:id', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const { name, mode, participants, sessionKey } = req.body;
  if (name !== undefined) thread.name = name;
  if (mode !== undefined) thread.mode = mode;
  if (participants !== undefined) thread.participants = participants;
  if (sessionKey !== undefined) thread.sessionKey = sessionKey;

  writeThread(thread);
  wsBroadcast({ type: 'thread_updated', threadId: thread.id, name: thread.name });
  res.json(thread);
});

// DELETE /api/threads/:id — delete thread
app.delete('/api/threads/:id', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  deleteThreadFile(req.params.id);
  wsBroadcast({ type: 'thread_deleted', threadId: req.params.id });
  res.json({ success: true, id: req.params.id });
});

// POST /api/threads/:id/messages — append message
app.post('/api/threads/:id/messages', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const { role, content, agentId, attachments } = req.body;
  if (!role || !content) {
    return errorResponse(res, 400, 'bad_request', 'role and content are required');
  }

  const message = {
    id: uuidv4(),
    role,
    content,
    timestamp: new Date().toISOString(),
    ...(agentId && { agentId }),
    ...(attachments && { attachments })
  };

  thread.messages.push(message);
  writeThread(thread);

  wsBroadcast({ type: 'message_added', threadId: thread.id, message });
  res.status(201).json(message);
});

// DELETE /api/threads/:id/messages/:msgId — delete message
app.delete('/api/threads/:id/messages/:msgId', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const idx = thread.messages.findIndex(m => m.id === req.params.msgId);
  if (idx === -1) return errorResponse(res, 404, 'not_found', 'Message not found');

  thread.messages.splice(idx, 1);
  writeThread(thread);

  wsBroadcast({ type: 'message_deleted', threadId: thread.id, messageId: req.params.msgId });
  res.json({ success: true, messageId: req.params.msgId });
});

// POST /api/threads/:id/messages/bulk — bulk append (for syncing entire thread)
app.post('/api/threads/:id/messages/bulk', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return errorResponse(res, 400, 'bad_request', 'messages array required');
  }

  for (const msg of messages) {
    thread.messages.push({
      id: msg.id || uuidv4(),
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp || new Date().toISOString(),
      ...(msg.agentId && { agentId: msg.agentId }),
      ...(msg.attachments && { attachments: msg.attachments })
    });
  }

  writeThread(thread);
  res.json({ success: true, count: messages.length });
});

// PUT /api/threads/:id/messages/:msgId — update message content (for streaming updates)
app.put('/api/threads/:id/messages/:msgId', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const msg = thread.messages.find(m => m.id === req.params.msgId);
  if (!msg) return errorResponse(res, 404, 'not_found', 'Message not found');

  if (req.body.content !== undefined) msg.content = req.body.content;
  if (req.body.agentId !== undefined) msg.agentId = req.body.agentId;

  writeThread(thread);
  res.json(msg);
});


// ══════════════════════════════════════════════
// 2. FILE UPLOAD
// ══════════════════════════════════════════════

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'text/html'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname) || '';
    const name = `${Date.now()}_${uuidv4().slice(0, 8)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  }
});

// POST /api/upload — multipart file upload
// Serve local image files by absolute path
app.get('/api/local-image', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return errorResponse(res, 400, 'bad_request', 'Missing path parameter');
  
  const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
  const ext = extname(filePath).toLowerCase();
  if (!allowedExts.includes(ext)) return errorResponse(res, 400, 'bad_request', 'Not an image file');
  if (!existsSync(filePath)) return errorResponse(res, 404, 'not_found', 'File not found');
  
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', mimeTypes[ext]);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  createReadStream(filePath).pipe(res);
});

app.post('/api/upload', upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return errorResponse(res, 400, 'bad_request', 'No files uploaded');
  }

  const results = req.files.map(f => ({
    filename: f.filename,
    originalName: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
    url: `/uploads/${f.filename}`
  }));

  res.json({ files: results });
});

// Handle multer errors
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return errorResponse(res, 400, 'upload_error', err.message);
  }
  if (err.message?.startsWith('Unsupported file type')) {
    return errorResponse(res, 400, 'upload_error', err.message);
  }
  next(err);
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  etag: true
}));


// ══════════════════════════════════════════════
// 3a. DIRECT API (Anthropic + OpenAI, with streaming)
// ══════════════════════════════════════════════════════

app.post('/api/chat/direct', express.json({ limit: '10mb' }), async (req, res) => {
  const { model, messages, threadId, agentId, thinkingBudget } = req.body;
  const resolvedModel = model || SELECTED_MODEL || 'anthropic/claude-sonnet-4';
  const provider = detectProvider(resolvedModel);

  if (provider === 'openai' && !OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }
  if (provider === 'anthropic' && !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  req.on('close', () => controller.abort());

  try {
    if (provider === 'openai') {
      await streamOpenAI(resolvedModel, messages, sendEvent, controller, timeout);
    } else {
      await streamAnthropic(resolvedModel, messages, thinkingBudget, sendEvent, controller, timeout);
    }

    if (!res.writableEnded) {
      sendEvent('done', {});
      res.end();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      sendEvent('error', { message: 'Request aborted' });
    } else {
      sendEvent('error', { message: err.message });
    }
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
  }
});

// ── Anthropic streaming handler ──
async function streamAnthropic(model, messages, thinkingBudget, sendEvent, controller) {
  const anthropicModel = mapModel(model);

  let systemPrompt = '';
  const anthropicMessages = [];
  for (const msg of (messages || [])) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
    } else {
      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
    anthropicMessages.unshift({ role: 'user', content: '(continue)' });
  }

  const budget = thinkingBudget || 16000;
  const requestBody = {
    model: anthropicModel,
    max_tokens: Math.max(budget + 4096, 32000),
    thinking: { type: 'enabled', budget_tokens: budget },
    stream: true,
    messages: anthropicMessages,
  };
  if (systemPrompt) requestBody.system = systemPrompt;

  const upstream = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    sendEvent('error', { message: `Anthropic API error: ${upstream.status}`, detail: errText });
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let thinkingText = '';
  let responseText = '';
  let currentBlockType = null;
  let thinkingStartTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const eventEnd = buffer.indexOf('\n\n');
      if (eventEnd === -1) break;
      const rawEvent = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      let eventType = '', eventData = '';
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData = line.slice(6);
      }
      if (!eventData) continue;
      let parsed;
      try { parsed = JSON.parse(eventData); } catch { continue; }

      switch (parsed.type) {
        case 'message_start':
          sendEvent('message_start', {
            model: parsed.message?.model,
            id: parsed.message?.id,
            inputTokens: parsed.message?.usage?.input_tokens,
          });
          break;
        case 'content_block_start':
          currentBlockType = parsed.content_block?.type;
          if (currentBlockType === 'thinking') {
            thinkingStartTime = Date.now();
            sendEvent('thinking_start', { index: parsed.index });
          } else if (currentBlockType === 'text') {
            sendEvent('text_start', { index: parsed.index });
          }
          break;
        case 'content_block_delta':
          if (parsed.delta?.type === 'thinking_delta') {
            thinkingText += parsed.delta.thinking;
            sendEvent('thinking_delta', { text: parsed.delta.thinking, elapsed: Date.now() - thinkingStartTime });
          } else if (parsed.delta?.type === 'text_delta') {
            responseText += parsed.delta.text;
            sendEvent('text_delta', { text: parsed.delta.text });
          }
          break;
        case 'content_block_stop':
          if (currentBlockType === 'thinking') {
            sendEvent('thinking_stop', { totalLength: thinkingText.length, elapsed: Date.now() - thinkingStartTime });
          } else if (currentBlockType === 'text') {
            sendEvent('text_stop', {});
          }
          currentBlockType = null;
          break;
        case 'message_delta':
          sendEvent('message_delta', { stopReason: parsed.delta?.stop_reason, outputTokens: parsed.usage?.output_tokens });
          break;
        case 'message_stop':
          sendEvent('message_stop', { thinking: thinkingText, response: responseText });
          break;
      }
    }
  }
}

// ── OpenAI streaming handler ──
async function streamOpenAI(model, messages, sendEvent, controller) {
  const openaiModel = model.replace(/^openai\//, '');
  const baseUrl = OPENAI_BASE_URL.replace(/\/+$/, '');

  // OpenAI accepts system messages inline — pass messages as-is
  const openaiMessages = (messages || []).map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  const requestBody = {
    model: openaiModel,
    messages: openaiMessages,
    stream: true,
  };

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    sendEvent('error', { message: `OpenAI API error: ${upstream.status}`, detail: errText });
    return;
  }

  sendEvent('message_start', { model: openaiModel });
  sendEvent('text_start', { index: 0 });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) break;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) {
        responseText += delta.content;
        sendEvent('text_delta', { text: delta.content });
      }

      // Handle finish reason
      if (parsed.choices?.[0]?.finish_reason) {
        sendEvent('text_stop', {});
        sendEvent('message_stop', { response: responseText });
      }
    }
  }

  // If we never got a finish_reason, close gracefully
  if (responseText) {
    sendEvent('text_stop', {});
    sendEvent('message_stop', { response: responseText });
  }
}

// 3. GATEWAY PROXY (SSE-compatible)
// ══════════════════════════════════════════════

// Apply rate limiting to gateway proxy
app.all('/v1/{*splat}', rateLimit, async (req, res) => {
  // Full URL for the gateway
  const url = `${GATEWAY}${req.originalUrl}`;

  // Collect raw body for proxy
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  await new Promise(resolve => req.on('end', resolve));
  const body = Buffer.concat(chunks);

  // Build upstream headers — pass through relevant headers
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
  // Forward agent ID header
  const agentId = req.headers['x-openclaw-agent-id'];
  if (agentId) headers['x-openclaw-agent-id'] = agentId;

  // Session key: prefer explicit header, then try to extract from body for thread mapping
  const sessionKeyHeader = req.headers['x-openclaw-session-key'];
  let threadSessionKey = null;
  if (!sessionKeyHeader) {
    try {
      if (body.length) {
        const parsed = JSON.parse(body.toString());
        const user = parsed.user || '';
        if (user.startsWith('vektor-terminal-thread_')) {
          const threadId = user.replace('vektor-terminal-', '');
          const thread = readThread(threadId);
          if (thread?.sessionKey) {
            threadSessionKey = thread.sessionKey;
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }
  if (sessionKeyHeader) {
    headers['x-openclaw-session-key'] = sessionKeyHeader;
  } else if (threadSessionKey) {
    headers['x-openclaw-session-key'] = threadSessionKey;
  } else {
    // Generic session key based on agent ID
    const effectiveAgent = agentId || 'main';
    headers['x-openclaw-session-key'] = `agent:${effectiveAgent}:main`;
  }

  // AbortController with generous timeout (5 min for tool-heavy responses)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      signal: controller.signal,
    });

    const ct = upstream.headers.get('content-type') || '';

    if (ct.includes('text/event-stream')) {
      // SSE streaming — critical path, must not buffer
      res.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (res.socket) res.socket.setNoDelay(true);

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (!res.writableEnded) {
            res.write(value);

            // Broadcast streaming chunks to WebSocket for tool-use detection
            try {
              const text = new TextDecoder().decode(value);
              parseSSEForEvents(text);
            } catch { /* non-critical */ }
          }
        }
      } catch (streamErr) {
        if (!res.writableEnded) {
          try { res.write(`data: [DONE]\n\n`); } catch {}
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
    } else {
      // Regular JSON response
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': ct || 'application/json' });
      res.end(text);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      errorResponse(res, 504, 'gateway_timeout', 'Gateway timeout (5min)');
    } else {
      errorResponse(res, 502, 'gateway_error', err.message);
    }
  } finally {
    clearTimeout(timeout);
  }
});

// Parse SSE chunks for tool-use events to broadcast via WebSocket
function parseSSEForEvents(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') {
      wsBroadcast({ type: 'stream_done' });
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      // Detect tool use events from the responses API
      if (parsed.type === 'response.function_call_arguments.delta' ||
          parsed.type === 'response.function_call_arguments.done') {
        wsBroadcast({
          type: 'tool_use',
          event: parsed.type,
          name: parsed.name || null
        });
      }
    } catch { /* ignore parse errors */ }
  }
}


// ══════════════════════════════════════════════
// 3b. CANVAS ARTIFACTS
// ══════════════════════════════════════════════

const ARTIFACTS_DIR = join(DATA_DIR, 'artifacts');
if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });

function artifactPath(id) {
  return join(ARTIFACTS_DIR, `${id}.json`);
}

function readArtifact(id) {
  const fp = artifactPath(id);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeArtifactVersions(versions = []) {
  if (!Array.isArray(versions)) return [];
  return versions
    .filter(version => version && typeof version.content === 'string')
    .map(version => ({
      content: version.content,
      timestamp: toIsoTimestamp(version.timestamp)
    }));
}

function normalizeArtifactPayload(payload = {}, existing = null) {
  const nowIso = new Date().toISOString();
  return {
    id: payload.id || existing?.id || ('artifact_' + Date.now() + '_' + uuidv4().slice(0, 8)),
    title: payload.title || existing?.title || 'Untitled',
    content: typeof payload.content === 'string' ? payload.content : (existing?.content || ''),
    type: payload.type || existing?.type || 'html',
    language: payload.language || existing?.language || 'html',
    versions: normalizeArtifactVersions(payload.versions ?? existing?.versions ?? []),
    createdAt: toIsoTimestamp(payload.createdAt || existing?.createdAt, nowIso),
    updatedAt: toIsoTimestamp(payload.updatedAt || existing?.updatedAt, nowIso),
    threadId: payload.threadId || existing?.threadId || null,
    threadTitle: payload.threadTitle || existing?.threadTitle || null
  };
}

// POST /api/canvas — save artifact
app.post('/api/canvas', (req, res) => {
  try {
    if (!req.body?.content && !req.body?.id) {
      return errorResponse(res, 400, 'bad_request', 'content is required');
    }

    const existing = req.body?.id ? readArtifact(req.body.id) : null;
    const artifact = normalizeArtifactPayload(req.body || {}, existing);
    if (!artifact.content) {
      return errorResponse(res, 400, 'bad_request', 'content is required');
    }

    writeFileSync(artifactPath(artifact.id), JSON.stringify(artifact, null, 2), 'utf-8');
    res.status(existing ? 200 : 201).json(artifact);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/canvas/:id — serve artifact HTML in iframe-safe way
app.get('/api/canvas/:id', (req, res) => {
  try {
    const fp = artifactPath(req.params.id);
    if (!existsSync(fp)) return errorResponse(res, 404, 'not_found', 'Artifact not found');
    
    const artifact = JSON.parse(readFileSync(fp, 'utf-8'));
    
    if (req.query.raw === 'true') {
      // Serve raw HTML for iframe
      res.type('html').send(artifact.content);
    } else {
      res.json(artifact);
    }
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/canvas — list all artifacts
app.get('/api/canvas', (req, res) => {
  try {
    const files = readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.json'));
    const artifacts = files.map(f => {
      try {
        const data = JSON.parse(readFileSync(join(ARTIFACTS_DIR, f), 'utf-8'));
        return {
          id: data.id,
          title: data.title,
          type: data.type,
          language: data.language,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          threadId: data.threadId || null,
          threadTitle: data.threadTitle || null,
          versions: normalizeArtifactVersions(data.versions),
          preview: (data.content || '').replace(/[#*`\n]/g, ' ').trim().slice(0, 140)
        };
      } catch { return null; }
    }).filter(Boolean);
    artifacts.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    res.json({ artifacts });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// DELETE /api/canvas/:id — delete artifact
app.delete('/api/canvas/:id', (req, res) => {
  try {
    const fp = artifactPath(req.params.id);
    if (!existsSync(fp)) return errorResponse(res, 404, 'not_found', 'Artifact not found');
    unlinkSync(fp);
    res.json({ success: true });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// ══════════════════════════════════════════════
// 4. COMMAND CENTER APIs
// ══════════════════════════════════════════════

// ── 4a. SKILLS BROWSER ──

function parseSkillMeta(skillDir) {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const meta = { name: basename(skillDir), description: '', content };

    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (nameMatch) meta.name = nameMatch[1].trim();
      if (descMatch) meta.description = descMatch[1].trim();
    }

    // If no description from frontmatter, grab first paragraph after heading
    if (!meta.description) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('name:') && !line.startsWith('description:') && !line.startsWith('allowed-tools:')) {
          meta.description = line.slice(0, 200);
          break;
        }
      }
    }

    return meta;
  } catch {
    return null;
  }
}

app.get('/api/skills', (req, res) => {
  try {
    const agentConfig = getAgentConfig(req.query.agent);
    const skills = [];
    for (const { path: dir, source } of agentConfig.skillDirs) {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const meta = parseSkillMeta(skillDir);
        if (meta) {
          skills.push({
            id: entry.name,
            name: meta.name,
            description: meta.description,
            source,
            path: skillDir,
          });
        }
      }
    }
    // Deduplicate by id (custom overrides clawdhub overrides builtin)
    const seen = new Map();
    const priority = { custom: 3, clawdhub: 2, builtin: 1 };
    for (const skill of skills) {
      const existing = seen.get(skill.id);
      if (!existing || priority[skill.source] > priority[existing.source]) {
        seen.set(skill.id, skill);
      }
    }
    const deduped = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ skills: deduped, total: deduped.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/skills/:id', (req, res) => {
  try {
    const agentConfig = getAgentConfig(req.query.agent);
    for (const { path: dir, source } of agentConfig.skillDirs) {
      const skillDir = join(dir, req.params.id);
      if (existsSync(skillDir)) {
        const meta = parseSkillMeta(skillDir);
        if (meta) {
          // List all files in skill directory
          const files = readdirSync(skillDir).filter(f => !f.startsWith('.'));
          return res.json({
            id: req.params.id,
            name: meta.name,
            description: meta.description,
            source,
            content: meta.content,
            files,
          });
        }
      }
    }
    errorResponse(res, 404, 'not_found', 'Skill not found');
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ── 4b. CONVERSATIONS ARCHIVE ──

async function parseSessionFile(filePath, { summaryOnly = false } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    let lineCount = 0;
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineCount++;
      // For summary mode, only read first 15 lines (session meta + first messages)
      if (summaryOnly && lineCount > 15) {
        rl.close();
        return;
      }
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    });
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve([]));
  });
}

function extractSessionSummary(records) {
  const session = records.find(r => r.type === 'session') || {};
  const modelChange = records.find(r => r.type === 'model_change');
  const messages = records.filter(r => r.type === 'message' && r.message);

  // Get first user message for preview
  const firstUser = messages.find(m => m.message.role === 'user');
  let preview = '';
  if (firstUser?.message?.content) {
    const content = firstUser.message.content;
    if (typeof content === 'string') {
      preview = content.slice(0, 200);
    } else if (Array.isArray(content)) {
      const textBlock = content.find(c => c.type === 'text');
      if (textBlock) preview = textBlock.text.slice(0, 200);
    }
  }

  // Strip cron prefixes from preview
  preview = preview.replace(/^\[cron:[^\]]+\]\s*/, '');

  // Calculate total cost
  let totalCost = 0;
  for (const msg of messages) {
    if (msg.message?.usage?.cost?.total) {
      totalCost += msg.message.usage.cost.total;
    }
  }

  return {
    id: session.id || basename(filePath, '.jsonl'),
    timestamp: session.timestamp || null,
    model: modelChange?.modelId || null,
    provider: modelChange?.provider || null,
    messageCount: messages.length,
    preview,
    totalCost: Math.round(totalCost * 10000) / 10000,
    isCron: preview.startsWith('[cron:') || (firstUser?.message?.content?.[0]?.text || '').includes('[cron:'),
  };
}

// Session index cache — rebuilt on first request and invalidated every 60s
let sessionIndexCache = null;
let sessionIndexCacheTime = 0;
const SESSION_CACHE_TTL = 60_000;

/**
 * Build a reverse map from sessionId → source by reading sessions.json.
 * Sources: 'vektor-terminal', 'telegram', 'cron', 'webchat', 'other'
 */
function buildSourceMap(agentName) {
  const sessionsJsonPath = join(AGENTS_DIR, agentName, 'sessions', 'sessions.json');
  if (!existsSync(sessionsJsonPath)) return {};

  try {
    const raw = readFileSync(sessionsJsonPath, 'utf-8');
    const data = JSON.parse(raw);
    const map = {};

    for (const [key, val] of Object.entries(data)) {
      const sid = val?.sessionId;
      if (!sid) continue;

      if (key.includes('vektor-terminal') || key.startsWith('vektor:thread_')) {
        map[sid] = 'vektor-terminal';
      } else if (key.includes('telegram')) {
        map[sid] = 'telegram';
      } else if (key.includes('cron')) {
        map[sid] = 'cron';
      } else if (key.includes('webchat')) {
        map[sid] = 'webchat';
      } else {
        map[sid] = 'other';
      }
    }

    return map;
  } catch {
    return {};
  }
}

async function buildSessionIndex() {
  const now = Date.now();
  if (sessionIndexCache && (now - sessionIndexCacheTime) < SESSION_CACHE_TTL) {
    return sessionIndexCache;
  }

  const agents = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name) : [];

  const sessions = [];
  const parsePromises = [];

  // Build source maps per agent
  const sourceMaps = {};
  for (const agentName of agents) {
    sourceMaps[agentName] = buildSourceMap(agentName);
  }

  for (const agentName of agents) {
    const sessionsDir = join(AGENTS_DIR, agentName, 'sessions');
    if (!existsSync(sessionsDir)) continue;

    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      parsePromises.push(
        (async () => {
          try {
            const stat = statSync(filePath);
            const records = await parseSessionFile(filePath, { summaryOnly: true });
            const summary = extractSessionSummary(records);
            summary.agent = agentName;
            summary.fileSize = stat.size;
            summary.modifiedAt = stat.mtime.toISOString();
            // Tag with source from sessions.json routing data
            summary.source = sourceMaps[agentName]?.[summary.id] || 'unknown';
            return summary;
          } catch { return null; }
        })()
      );
    }
  }

  const results = await Promise.all(parsePromises);
  for (const s of results) {
    if (s) sessions.push(s);
  }

  // Sort by timestamp descending
  sessions.sort((a, b) => {
    const ta = a.timestamp || a.modifiedAt || '';
    const tb = b.timestamp || b.modifiedAt || '';
    return tb.localeCompare(ta);
  });

  // Collect unique sources for filter UI
  const sources = [...new Set(sessions.map(s => s.source).filter(Boolean))].sort();

  sessionIndexCache = { sessions, agents, sources };
  sessionIndexCacheTime = now;
  return sessionIndexCache;
}

app.get('/api/sessions', async (req, res) => {
  try {
    const { agent, source, limit = 50, offset = 0, search } = req.query;
    const { sessions: allSessions, agents, sources } = await buildSessionIndex();

    let filtered = allSessions;
    if (agent) filtered = filtered.filter(s => s.agent === agent);
    if (source) filtered = filtered.filter(s => s.source === source);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(s =>
        s.preview.toLowerCase().includes(q) || s.id.includes(q)
      );
    }

    const total = filtered.length;
    const paged = filtered.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ sessions: paged, total, agents, sources });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/sessions/:agent/:id', async (req, res) => {
  try {
    const filePath = join(AGENTS_DIR, req.params.agent, 'sessions', `${req.params.id}.jsonl`);
    if (!existsSync(filePath)) return errorResponse(res, 404, 'not_found', 'Session not found');

    const records = await parseSessionFile(filePath);
    const summary = extractSessionSummary(records);
    summary.agent = req.params.agent;

    // Extract full message transcript
    const transcript = records
      .filter(r => r.type === 'message' && r.message)
      .map(r => ({
        id: r.id,
        role: r.message.role,
        content: typeof r.message.content === 'string'
          ? r.message.content
          : (r.message.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
        timestamp: r.timestamp,
        model: r.message.model || null,
        usage: r.message.usage || null,
        toolUse: (r.message.content || []).filter(c => c.type === 'tool_use').map(c => ({
          name: c.name,
          id: c.id,
        })),
      }));

    res.json({ ...summary, transcript });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ── 4c. CRON JOBS / SCHEDULED TASKS ──

const CRON_JOBS_FILE = join(OPENCLAW_DIR, 'cron', 'jobs.json');
const CRON_RUNS_DIR = join(OPENCLAW_DIR, 'cron', 'runs');

function readCronJobs() {
  if (!existsSync(CRON_JOBS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(CRON_JOBS_FILE, 'utf-8'));
    return data.jobs || [];
  } catch { return []; }
}

function formatCronSchedule(schedule) {
  if (!schedule) return '';
  const { expr, tz } = schedule;
  // Human-readable cron expression
  const parts = (expr || '').split(' ');
  if (parts.length < 5) return expr;

  const [min, hour, dom, mon, dow] = parts;
  let desc = '';
  if (min === '0' && hour.startsWith('*/')) desc = `Every ${hour.slice(2)} hours`;
  else if (min.match(/^\d+$/) && hour.startsWith('*/')) desc = `At :${min.padStart(2,'0')} every ${hour.slice(2)} hours`;
  else if (hour.includes('-')) desc = `${min === '0' ? 'On the hour' : `At :${min}`}, ${hour} hours`;
  else desc = expr;

  if (tz) desc += ` (${tz.replace('America/', '')})`;
  return desc;
}

app.get('/api/cron', (req, res) => {
  try {
    const jobs = readCronJobs().map(job => ({
      ...job,
      scheduleHuman: formatCronSchedule(job.schedule),
      nextRun: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
      lastRun: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
      lastStatus: job.state?.lastStatus || null,
      lastDuration: job.state?.lastDurationMs ? Math.round(job.state.lastDurationMs / 1000) : null,
    }));
    res.json({ jobs, total: jobs.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/cron/:id/runs', (req, res) => {
  try {
    // Check runs directory for this job
    const runsDir = join(CRON_RUNS_DIR, req.params.id);
    if (!existsSync(runsDir)) {
      // Try flat runs directory
      const runs = [];
      if (existsSync(CRON_RUNS_DIR)) {
        for (const f of readdirSync(CRON_RUNS_DIR)) {
          if (f.startsWith(req.params.id) && f.endsWith('.json')) {
            try {
              const data = JSON.parse(readFileSync(join(CRON_RUNS_DIR, f), 'utf-8'));
              runs.push(data);
            } catch {}
          }
        }
      }
      return res.json({ runs });
    }

    const runs = [];
    for (const f of readdirSync(runsDir).filter(f => f.endsWith('.json')).slice(-20)) {
      try {
        const data = JSON.parse(readFileSync(join(runsDir, f), 'utf-8'));
        runs.push(data);
      } catch {}
    }
    runs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    res.json({ runs });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ── 4d. PROJECTS ──

function discoverProjects(agentId) {
  const agentConfig = getAgentConfig(agentId);
  const projects = [];

  // Scan agent workspace for project dirs (has package.json, pyproject.toml, Cargo.toml, or .git)
  const projectMarkers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'setup.py'];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'memory', 'memories', 'skills', 'design-refs', 'design-agents', 'research', 'ops', 'canvas', 'chatgpt-v2-designs', 'polyphonic-ref', 'x-drafts']);

  if (existsSync(agentConfig.workspace)) {
    for (const entry of readdirSync(agentConfig.workspace, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const dir = join(agentConfig.workspace, entry.name);
      const hasMarker = projectMarkers.some(m => existsSync(join(dir, m)));
      const hasGit = existsSync(join(dir, '.git'));

      if (hasMarker || hasGit) {
        const project = {
          id: entry.name,
          name: entry.name,
          path: dir,
          workspace: basename(agentConfig.workspace),
          markers: [],
        };

        // Try to read package.json for metadata
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            project.name = pkg.name || entry.name;
            project.description = pkg.description || '';
            project.version = pkg.version;
            project.markers.push('node');
          } catch { /* skip */ }
        }

        // Check for Python
        if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py')) || existsSync(join(dir, 'requirements.txt'))) {
          project.markers.push('python');
        }

        // Check for Rust
        if (existsSync(join(dir, 'Cargo.toml'))) {
          project.markers.push('rust');
        }

        // Check git info
        if (hasGit) {
          project.markers.push('git');
          try {
            const remote = execSync('git remote get-url origin 2>/dev/null', { cwd: dir, encoding: 'utf-8' }).trim();
            project.gitRemote = remote;
          } catch { /* no remote */ }
          try {
            const lastCommit = execSync('git log -1 --format="%H|%s|%ai" 2>/dev/null', { cwd: dir, encoding: 'utf-8' }).trim();
            const [hash, message, date] = lastCommit.split('|');
            project.lastCommit = { hash: hash?.slice(0, 8), message, date };
          } catch { /* no commits */ }
        }

        // Check for README
        const readmePath = join(dir, 'README.md');
        if (existsSync(readmePath)) {
          try {
            const readme = readFileSync(readmePath, 'utf-8');
            if (!project.description) {
              // Grab first paragraph after title
              const lines = readme.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line && !line.startsWith('#')) {
                  project.description = line.slice(0, 300);
                  break;
                }
              }
            }
            project.hasReadme = true;
          } catch { /* skip */ }
        }

        // Stat for last modified
        try {
          const stat = statSync(dir);
          project.modifiedAt = stat.mtime.toISOString();
        } catch { /* skip */ }

        projects.push(project);
      }
    }
  }

  // Sort by last modified
  projects.sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));
  return projects;
}

app.get('/api/projects', (req, res) => {
  try {
    const projects = discoverProjects(req.query.agent);
    res.json({ projects, total: projects.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const projects = discoverProjects(req.query.agent);
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return errorResponse(res, 404, 'not_found', 'Project not found');

    // Add directory listing
    try {
      project.files = readdirSync(project.path)
        .filter(f => !f.startsWith('.') && f !== 'node_modules')
        .slice(0, 50);
    } catch { project.files = []; }

    // Read README if available
    const readmePath = join(project.path, 'README.md');
    if (existsSync(readmePath)) {
      try { project.readme = readFileSync(readmePath, 'utf-8'); } catch {}
    }

    res.json(project);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ── 4e. MEMORY EXPLORER ──

app.get('/api/journal', (req, res) => {
  try {
    const agentId = req.query.agent || 'main';
    const agentConfig = getAgentConfig(agentId);

    // Journal path comes from agent config; if not configured, return empty
    if (!agentConfig.journalPath) {
      return res.json({ generated: null, stats: {}, sections: {} });
    }

    if (!existsSync(agentConfig.journalPath)) {
      return res.json({ generated: null, stats: {}, sections: {} });
    }
    const data = JSON.parse(readFileSync(agentConfig.journalPath, 'utf-8'));
    res.json(data);
  } catch (err) {
    console.error('Journal feed error:', err.message);
    res.status(500).json({ error: 'Failed to read journal feed' });
  }
});

app.get('/api/memory', (req, res) => {
  try {
    const agentConfig = getAgentConfig(req.query.agent);
    const files = [];

    // Main MEMORY.md
    if (existsSync(agentConfig.memoryFile)) {
      const stat = statSync(agentConfig.memoryFile);
      files.push({
        id: 'MEMORY.md',
        name: 'MEMORY.md',
        path: agentConfig.memoryFile,
        type: 'core',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    // Memory directory files
    if (existsSync(agentConfig.memoryDir)) {
      for (const entry of readdirSync(agentConfig.memoryDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Scan subdirectories like reflections/
          const subDir = join(agentConfig.memoryDir, entry.name);
          for (const sub of readdirSync(subDir)) {
            const fp = join(subDir, sub);
            try {
              const stat = statSync(fp);
              files.push({
                id: `${entry.name}/${sub}`,
                name: sub,
                path: fp,
                type: entry.name,
                size: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              });
            } catch {}
          }
        } else {
          const fp = join(agentConfig.memoryDir, entry.name);
          try {
            const stat = statSync(fp);
            // Categorize by filename pattern
            let type = 'other';
            if (entry.name.match(/^\d{4}-\d{2}-\d{2}/)) type = 'daily';
            else if (entry.name === 'active-context.md') type = 'context';
            else if (entry.name === 'cognitive-genome.md') type = 'genome';
            else if (entry.name === 'identity.md') type = 'identity';
            else if (entry.name.endsWith('.json')) type = 'data';
            else if (entry.name.endsWith('.md')) type = 'document';

            files.push({
              id: entry.name,
              name: entry.name,
              path: fp,
              type,
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
          } catch {}
        }
      }
    }

    // Sort: core first, then by modified date
    files.sort((a, b) => {
      if (a.type === 'core') return -1;
      if (b.type === 'core') return 1;
      return (b.modifiedAt || '').localeCompare(a.modifiedAt || '');
    });

    res.json({ files, total: files.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/memory/:id', (req, res) => {
  try {
    const agentConfig = getAgentConfig(req.query.agent);
    // Handle nested paths like reflections/file.md
    const id = req.params.id;
    let filePath;

    if (id === 'MEMORY.md') {
      filePath = agentConfig.memoryFile;
    } else {
      filePath = join(agentConfig.memoryDir, id);
    }

    if (!existsSync(filePath)) return errorResponse(res, 404, 'not_found', 'Memory file not found');

    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);

    res.json({
      id,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// Handle nested memory paths (e.g., reflections/file.md)
app.get('/api/memory/:dir/:file', (req, res) => {
  try {
    const agentConfig = getAgentConfig(req.query.agent);
    const filePath = join(agentConfig.memoryDir, req.params.dir, req.params.file);
    if (!existsSync(filePath)) return errorResponse(res, 404, 'not_found', 'Memory file not found');

    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);

    res.json({
      id: `${req.params.dir}/${req.params.file}`,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ── 4e-2. CONTEXT PACKET ──

// Simple server-side cache for context packets
const contextPacketCache = {};
const CONTEXT_PACKET_TTL = 60_000; // 60 seconds

function buildTemporalContext() {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';
  return `Current time: ${now.toISOString()} (${days[now.getDay()]}), timezone: ${tz}. Via Vektor Terminal.`;
}

function readActiveContext(agentId) {
  try {
    const agentCfg = getAgentConfig(agentId);
    if (!agentCfg.memoryDir) return '';
    const activeContextPath = join(agentCfg.memoryDir, 'active-context.md');
    if (!existsSync(activeContextPath)) return '';
    const content = readFileSync(activeContextPath, 'utf-8');
    const lines = content.split('\n');
    const entries = [];
    let currentProject = null;
    let isBackground = false;
    for (const line of lines) {
      // Match ## ProjectName or ## ProjectName [background]
      const headerMatch = line.match(/^## (.+?)(?:\s+\[background\])?$/);
      if (headerMatch) {
        isBackground = /\[background\]/.test(line);
        currentProject = headerMatch[1].trim();
        continue;
      }
      if (isBackground) continue;
      if (currentProject && line.startsWith('- ')) {
        entries.push(`[${currentProject}] ${line.slice(2).trim()}`);
        if (entries.length >= 5) break;
      }
    }
    return entries.length ? 'Active context:\n' + entries.join('\n') : '';
  } catch {
    return '';
  }
}

function readCrossAgentContext(agentId) {
  try {
    if (!existsSync(CROSS_AGENT_CONTEXT_PATH)) return '';
    const content = readFileSync(CROSS_AGENT_CONTEXT_PATH, 'utf-8');
    // Extract emotional state and recent thoughts (compact)
    const sections = [];
    // Extract emotional dimensions
    const emotionalMatch = content.match(/### Emotional Dimensions\n([\s\S]*?)(?=\n###|\n---|\n##)/);
    if (emotionalMatch) {
      const dims = emotionalMatch[1].trim().split('\n')
        .filter(l => l.trim())
        .map(l => l.trim())
        .slice(0, 4);
      if (dims.length) sections.push('Emotional state: ' + dims.join(', '));
    }
    // Extract recent thoughts (first 2)
    const thoughtsMatch = content.match(/### Recent Thoughts\n([\s\S]*?)(?=\n---|\n##)/);
    if (thoughtsMatch) {
      const thoughts = thoughtsMatch[1].trim().split('\n- ')
        .filter(l => l.trim())
        .slice(0, 2)
        .map(t => t.split('\n')[0].trim()); // first line only
      if (thoughts.length) sections.push('Recent thoughts: ' + thoughts.join(' | '));
    }
    return sections.join('\n');
  } catch {
    return '';
  }
}

app.get('/api/context-packet/:agentId', async (req, res) => {
  const agentId = req.params.agentId || 'main';
  const topic = (req.query.topic || '').trim();
  const cacheKey = `${agentId}:${topic}`;
  const now = Date.now();

  // Check cache
  const cached = contextPacketCache[cacheKey];
  if (cached && (now - cached.time) < CONTEXT_PACKET_TTL) {
    const remainingTtl = Math.ceil((CONTEXT_PACKET_TTL - (now - cached.time)) / 1000);
    res.set('Cache-Control', 'max-age=120');
    return res.json({ context: cached.context, cached: true, ttl: remainingTtl });
  }

  try {
    // 1. Temporal context (always available)
    const temporal = buildTemporalContext();

    // 2. Active context from memory files
    const activeCtx = readActiveContext(agentId);

    // 3. Cross-agent context
    const crossCtx = readCrossAgentContext(agentId);

    // Assemble final context
    const parts = [temporal, activeCtx, crossCtx].filter(Boolean);
    const context = parts.join('\n\n');

    // Cache result
    contextPacketCache[cacheKey] = { context, time: now };

    res.set('Cache-Control', 'max-age=120');
    res.json({ context, cached: false, ttl: Math.ceil(CONTEXT_PACKET_TTL / 1000) });
  } catch (err) {
    // Never fail — return at least temporal context
    const fallback = buildTemporalContext();
    res.set('Cache-Control', 'max-age=120');
    res.json({ context: fallback, cached: false, ttl: 0, error: err.message });
  }
});


// ── 4f. SYSTEM STATUS ──

app.get('/api/system', async (req, res) => {
  try {
    const status = {
      server: {
        uptime: process.uptime(),
        port: PORT,
        wsClients: wss?.clients?.size || 0,
        threads: readdirSync(THREADS_DIR).filter(f => f.endsWith('.json')).length,
      },
      gateway: null,
      agents: [],
    };

    // Try to get gateway status
    try {
      const gwRes = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(3000) });
      if (gwRes.ok) {
        const contentType = gwRes.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          status.gateway = await gwRes.json();
        } else {
          const text = await gwRes.text();
          const title = text.match(/<title>([^<]+)<\/title>/i)?.[1] || null;
          status.gateway = {
            status: 'reachable',
            endpoint: '/health',
            statusCode: gwRes.status,
            contentType,
            title,
          };
        }
      } else {
        status.gateway = {
          status: 'degraded',
          endpoint: '/health',
          statusCode: gwRes.status,
        };
      }
    } catch {
      status.gateway = { status: 'unreachable' };
    }

    // Discover agents
    if (existsSync(AGENTS_DIR)) {
      for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionsDir = join(AGENTS_DIR, entry.name, 'sessions');
        const sessionCount = existsSync(sessionsDir) ?
          readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).length : 0;
        status.agents.push({ name: entry.name, sessions: sessionCount });
      }
    }

    res.json(status);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});


// ══════════════════════════════════════════════
// 5. STATIC FILE SERVING
// ══════════════════════════════════════════════

// Serve static assets from /public/
app.use('/public', express.static(PUBLIC_DIR));


// ══════════════════════════════════════════════
// NOTIFICATION SYSTEM
// ══════════════════════════════════════════════

const NOTIF_FILE = join(DATA_DIR, 'notifications.json');

function loadNotifStore() {
  try {
    if (existsSync(NOTIF_FILE)) return JSON.parse(readFileSync(NOTIF_FILE, 'utf-8'));
  } catch {}
  return [];
}

function saveNotifStore(notifs) {
  try { writeFileSync(NOTIF_FILE, JSON.stringify(notifs, null, 2)); } catch {}
}

// GET — fetch all notifications
app.get('/api/notifications', (req, res) => {
  const notifs = loadNotifStore();
  res.json(notifs);
});

// POST — create a new notification (called by gateway or sub-agents)
app.post('/api/notifications', (req, res) => {
  const { type, title, body, action } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const notif = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    type: type || 'info',
    title,
    body: body || '',
    timestamp: Date.now(),
    read: false,
    action: action || null
  };

  const notifs = loadNotifStore();
  notifs.unshift(notif);
  // Cap at 100
  if (notifs.length > 100) notifs.length = 100;
  saveNotifStore(notifs);

  // Push to all connected WebSocket clients
  wsBroadcast({ type: 'notification', notification: notif });

  res.json(notif);
});

// POST — mark single notification as read
app.post('/api/notifications/:id/read', (req, res) => {
  const notifs = loadNotifStore();
  const notif = notifs.find(n => n.id === req.params.id);
  if (notif) {
    notif.read = true;
    saveNotifStore(notifs);
  }
  res.json({ ok: true });
});

// POST — clear all notifications
app.post('/api/notifications/clear', (req, res) => {
  saveNotifStore([]);
  res.json({ ok: true });
});


// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    threads: readdirSync(THREADS_DIR).filter(f => f.endsWith('.json')).length,
    uploads: readdirSync(UPLOADS_DIR).length,
    wsClients: wss?.clients?.size || 0
  });
});

// Serve index.html at root (with hot-reload in dev)
app.get('/', (req, res) => {
  try {
    const fresh = readFileSync(join(__dirname, 'index.html'), 'utf-8');
    res.type('html').send(fresh);
  } catch (err) {
    res.status(500).send('Failed to load index.html');
  }
});

app.get('/index.html', (req, res) => {
  res.redirect('/');
});

app.get('/components', (req, res) => {
  try {
    const fresh = readFileSync(join(__dirname, 'component-gallery.html'), 'utf-8');
    res.type('html').send(fresh);
  } catch (err) {
    res.status(500).send('Failed to load component-gallery.html');
  }
});


// Favicon
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});


// ══════════════════════════════════════════════
// 5. WEBSOCKET SERVER
// ══════════════════════════════════════════════

const wss = new WebSocketServer({ server, path: '/ws' });

// Ping interval to keep connections alive
const WS_PING_INTERVAL = 30_000;

wss.on('connection', (ws, req) => {
  const clientId = uuidv4().slice(0, 8);
  ws._clientId = clientId;
  ws._alive = true;

  console.log(`[WS] Client ${clientId} connected (total: ${wss.clients.size})`);

  ws.on('pong', () => {
    ws._alive = true;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWSMessage(ws, msg);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client ${clientId} disconnected (total: ${wss.clients.size})`);
  });

  // Send welcome
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    serverTime: new Date().toISOString()
  }));
});

// WS ping keep-alive
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) {
      ws.terminate();
      return;
    }
    ws._alive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('close', () => {
  clearInterval(pingInterval);
});

function handleWSMessage(ws, msg) {
  switch (msg.type) {
    case 'typing':
      // Broadcast typing indicator to other clients
      wsBroadcast({
        type: 'typing',
        threadId: msg.threadId,
        user: msg.user || 'user',
        isTyping: msg.isTyping ?? true
      }, ws); // exclude sender
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      break;

    case 'subscribe':
      // Subscribe to specific thread events
      ws._subscribedThread = msg.threadId;
      break;

    case 'open_canvas':
      // Broadcast canvas open event to all clients (including sender for self-push)
      wsBroadcast({
        type: 'open_canvas',
        title: msg.title || 'Untitled',
        content: msg.content,
        artifactType: msg.artifactType || 'markdown',
        language: msg.language || 'text'
      });
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

function wsBroadcast(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}


// ══════════════════════════════════════════════
// CONVERSATION ARCHIVE (EPISODIC MEMORY)
// ══════════════════════════════════════════════

const CONVERSATIONS_DIR = join(ARCHIVE_DIR, 'conversations');
const CONVERSATIONS_INDEX_FILE = join(CONVERSATIONS_DIR, 'index.json');

// Ensure conversations directory exists
if (!existsSync(CONVERSATIONS_DIR)) mkdirSync(CONVERSATIONS_DIR, { recursive: true });

function loadConversationsIndex() {
  if (!existsSync(CONVERSATIONS_INDEX_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CONVERSATIONS_INDEX_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveConversationsIndex(index) {
  try {
    writeFileSync(CONVERSATIONS_INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Archive] Failed to save index:', err);
  }
}

// POST /api/threads/:id/archive — archive thread to JSONL
app.post('/api/threads/:id/archive', (req, res) => {
  try {
    const thread = req.body.thread || readThread(req.params.id);
    if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateDir = join(CONVERSATIONS_DIR, dateStr);
    if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true });

    const archivePath = join(dateDir, `thread-${thread.id}.jsonl`);
    const lines = thread.messages.map(m => JSON.stringify({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || now.toISOString(),
      agentId: m.agentId || thread.agentId || 'main'
    }));

    writeFileSync(archivePath, lines.join('\n') + '\n', 'utf-8');

    // Update index
    const index = loadConversationsIndex();
    const existingIdx = index.findIndex(e => e.threadId === thread.id);
    const entry = {
      threadId: thread.id,
      title: thread.name || `Thread ${thread.id}`,
      date: dateStr,
      messageCount: thread.messages.length,
      firstMessageTimestamp: thread.messages[0]?.timestamp || now.toISOString(),
      lastMessageTimestamp: thread.messages[thread.messages.length - 1]?.timestamp || now.toISOString(),
      archivedAt: now.toISOString()
    };

    if (existingIdx >= 0) {
      index[existingIdx] = entry;
    } else {
      index.push(entry);
    }

    saveConversationsIndex(index);

    const storedThread = readThread(thread.id);
    if (storedThread) {
      storedThread.lastArchivedAt = entry.archivedAt;
      writeThread(storedThread);
    }

    res.json({ success: true, path: archivePath, entry });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/conversations/index — return index of all archived conversations
app.get('/api/conversations/index', (req, res) => {
  try {
    const index = loadConversationsIndex();
    res.json({ conversations: index, total: index.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/conversations/:date/:threadId — return full transcript of an archived thread
app.get('/api/conversations/:date/:threadId', (req, res) => {
  try {
    const { date, threadId } = req.params;
    const archivePath = join(CONVERSATIONS_DIR, date, `thread-${threadId}.jsonl`);
    
    if (!existsSync(archivePath)) {
      return errorResponse(res, 404, 'not_found', 'Archived conversation not found');
    }

    const content = readFileSync(archivePath, 'utf-8');
    const messages = content.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    res.json({ messages, threadId, date });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/conversations/search — search conversation archives
app.get('/api/conversations/search', (req, res) => {
  try {
    const { q, date } = req.query;
    const index = loadConversationsIndex();
    let matches = [];

    // Filter by date if provided
    let searchEntries = index;
    if (date) {
      searchEntries = index.filter(e => e.date === date);
    }

    // If no query, return all (filtered by date)
    if (!q) {
      matches = searchEntries.map(e => ({ ...e, snippets: [] }));
      return res.json({ results: matches, total: matches.length });
    }

    const query = q.toLowerCase();

    // Search through transcripts
    for (const entry of searchEntries) {
      const archivePath = join(CONVERSATIONS_DIR, entry.date, `thread-${entry.threadId}.jsonl`);
      if (!existsSync(archivePath)) continue;

      try {
        const content = readFileSync(archivePath, 'utf-8');
        const messages = content.trim().split('\n').map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        const snippets = [];
        for (const msg of messages) {
          if (msg.content && msg.content.toLowerCase().includes(query)) {
            const idx = msg.content.toLowerCase().indexOf(query);
            const start = Math.max(0, idx - 50);
            const end = Math.min(msg.content.length, idx + query.length + 50);
            let snippet = msg.content.slice(start, end);
            if (start > 0) snippet = '...' + snippet;
            if (end < msg.content.length) snippet = snippet + '...';
            snippets.push({ role: msg.role, snippet, timestamp: msg.timestamp });
            if (snippets.length >= 3) break; // Max 3 snippets per thread
          }
        }

        if (snippets.length > 0) {
          matches.push({ ...entry, snippets });
        }
      } catch (err) {
        console.error('[Search] Error reading archive:', archivePath, err);
      }
    }

    res.json({ results: matches, total: matches.length, query: q });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// POST /api/threads/:id/resume — prepare thread for resumption
app.post('/api/threads/:id/resume', (req, res) => {
  try {
    // Get thread from request body or from server storage
    let thread = req.body.thread || readThread(req.params.id);
    if (!thread) {
      // Try to load from archive
      const index = loadConversationsIndex();
      const entry = index.find(e => e.threadId === req.params.id);
      if (!entry) {
        return errorResponse(res, 404, 'not_found', 'Thread not found');
      }
      const archivePath = join(CONVERSATIONS_DIR, entry.date, `thread-${entry.threadId}.jsonl`);
      if (!existsSync(archivePath)) {
        return errorResponse(res, 404, 'not_found', 'Thread archive not found');
      }
      const content = readFileSync(archivePath, 'utf-8');
      const messages = content.trim().split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      thread = { id: req.params.id, name: entry.title, messages };
    }

    if (!thread.messages || thread.messages.length === 0) {
      return errorResponse(res, 400, 'bad_request', 'Thread has no messages');
    }

    // Take last N message pairs (user+assistant = 1 pair), targeting ~8000 tokens (~32000 chars)
    const TARGET_CHARS = 32000;
    let recentMessages = [];
    let charCount = 0;
    let pairCount = 0;

    // Work backwards, collecting pairs
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const msg = thread.messages[i];
      const msgChars = (msg.content || '').length;
      
      recentMessages.unshift(msg);
      charCount += msgChars;
      
      // Count as pair if we have user+assistant sequence
      if (msg.role === 'user' && i + 1 < thread.messages.length && thread.messages[i + 1].role === 'assistant') {
        pairCount++;
      }

      // Stop if we have enough pairs or too many chars
      if (pairCount >= 20 || charCount > TARGET_CHARS) break;
    }

    // Generate summary from messages BEFORE the carried-over ones
    const summaryStartIdx = 0;
    const summaryEndIdx = thread.messages.length - recentMessages.length;
    const summaryMessages = thread.messages.slice(summaryStartIdx, summaryEndIdx);
    
    // Dialogue-pair summary: walk messages as (user, assistant) pairs
    const SUMMARY_CHAR_CAP = 4000;
    const dialoguePairs = [];
    let summaryCharCount = 0;
    for (let i = 0; i < summaryMessages.length; i++) {
      const msg = summaryMessages[i];
      if (msg.role !== 'user') continue;
      const userContent = (msg.content || '').replace(/\s+/g, ' ').trim();
      if (!userContent) continue;
      // Truncate at word boundary
      let userSnip = userContent.slice(0, 200);
      if (userContent.length > 200) {
        const lastSpace = userSnip.lastIndexOf(' ');
        if (lastSpace > 150) userSnip = userSnip.slice(0, lastSpace);
        userSnip += '…';
      }
      let pair = `${USER_NAME}: ${userSnip}`;
      // Look for the next assistant message
      const nextMsg = summaryMessages[i + 1];
      if (nextMsg && nextMsg.role === 'assistant') {
        const assistantContent = (nextMsg.content || '').replace(/\s+/g, ' ').trim();
        if (assistantContent) {
          let assistantSnip = assistantContent.slice(0, 300);
          if (assistantContent.length > 300) {
            const lastSpace = assistantSnip.lastIndexOf(' ');
            if (lastSpace > 220) assistantSnip = assistantSnip.slice(0, lastSpace);
            assistantSnip += '…';
          }
          pair += `\nAssistant: ${assistantSnip}`;
        }
      }
      dialoguePairs.push(pair);
      summaryCharCount += pair.length;
      if (summaryCharCount > SUMMARY_CHAR_CAP) break;
    }
    // When over cap, prefer most recent pairs
    let finalPairs = dialoguePairs;
    if (summaryCharCount > SUMMARY_CHAR_CAP && dialoguePairs.length > 2) {
      // Keep first pair for context + as many recent pairs as fit
      let recentChars = dialoguePairs[0].length;
      const kept = [dialoguePairs[0]];
      for (let i = dialoguePairs.length - 1; i >= 1; i--) {
        if (recentChars + dialoguePairs[i].length + 10 > SUMMARY_CHAR_CAP) break;
        recentChars += dialoguePairs[i].length + 1;
        kept.push(dialoguePairs[i]);
      }
      if (kept.length > 1) {
        // kept[0] is first, rest are in reverse order — re-sort
        const first = kept.shift();
        kept.reverse();
        finalPairs = [first, '(…earlier exchanges omitted…)', ...kept];
      }
    }
    const summary = finalPairs.length > 0 ? finalPairs.join('\n\n') : '(Earlier discussion not summarized)';

    res.json({
      summary,
      recentMessages,
      originalThreadId: thread.id,
      originalThreadName: thread.name || `Thread ${thread.id}`,
      totalMessages: thread.messages.length,
      carriedOverMessages: recentMessages.length
    });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// Auto-archive: periodic check for threads with >5 messages
let autoArchiveTimer = null;
function startAutoArchive() {
  if (autoArchiveTimer) return;
  autoArchiveTimer = setInterval(() => {
    try {
      const files = readdirSync(THREADS_DIR).filter(f => f.endsWith('.json'));
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      // Load index once for the entire batch
      const index = loadConversationsIndex();
      let indexDirty = false;

      for (const file of files) {
        try {
          const thread = JSON.parse(readFileSync(join(THREADS_DIR, file), 'utf-8'));
          if ((thread.messages || []).length > 5) {
            const dateDir = join(CONVERSATIONS_DIR, dateStr);
            if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true });

            const archivePath = join(dateDir, `thread-${thread.id}.jsonl`);
            const lines = thread.messages.map(m => JSON.stringify({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp || now.toISOString(),
              agentId: m.agentId || thread.agentId || 'main'
            }));

            writeFileSync(archivePath, lines.join('\n') + '\n', 'utf-8');

            // Update index entry
            const existingIdx = index.findIndex(e => e.threadId === thread.id);
            const entry = {
              threadId: thread.id,
              title: thread.name || `Thread ${thread.id}`,
              date: dateStr,
              messageCount: thread.messages.length,
              firstMessageTimestamp: thread.messages[0]?.timestamp || now.toISOString(),
              lastMessageTimestamp: thread.messages[thread.messages.length - 1]?.timestamp || now.toISOString(),
              archivedAt: now.toISOString()
            };

            if (existingIdx >= 0) {
              index[existingIdx] = entry;
            } else {
              index.push(entry);
            }
            indexDirty = true;
          }
        } catch (err) {
          console.error('[AutoArchive] Error processing thread:', file, err);
        }
      }

      if (indexDirty) saveConversationsIndex(index);
    } catch (err) {
      console.error('[AutoArchive] Error:', err);
    }
  }, 60_000); // Run every 60 seconds
}

// Start auto-archive on server boot
startAutoArchive();

// ══════════════════════════════════════════════
// 6. SERVER STARTUP
// ══════════════════════════════════════════════

// Keep-alive settings for SSE
server.keepAliveTimeout = 300_000;
server.headersTimeout = 305_000;
server.timeout = 0; // No socket timeout for SSE

// Graceful shutdown
// ── File Reader API (for clickable file links + canvas) ──
app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  // Resolve ~ to home directory
  const resolved = filePath.startsWith('~') ? join(homedir(), filePath.slice(1)) : filePath;

  // Security: only allow reading from known safe directories
  // Include agent workspace paths from config + data directory
  const allowed = [
    DATA_DIR,
    join(homedir(), 'Documents'),
    ...Object.values(AGENT_CONFIG)
      .filter(a => a.workspace)
      .map(a => a.workspace),
  ];
  if (!allowed.some(dir => resolved.startsWith(dir))) {
    return res.status(403).json({ error: 'Path not in allowed directories' });
  }

  try {
    if (!existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    const stat = statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'File too large (5MB max)' });
    const content = readFileSync(resolved, 'utf-8');
    const ext = extname(resolved).toLowerCase().replace('.', '');
    res.json({ content, path: resolved, extension: ext, size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function shutdown() {
  console.log('\n⏀ Shutting down...');
  if (autoArchiveTimer) clearInterval(autoArchiveTimer);
  wss.clients.forEach(ws => ws.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // Force exit after 5s
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  const threadCount = readdirSync(THREADS_DIR).filter(f => f.endsWith('.json')).length;
  console.log(`⏀ Vektor Terminal → http://localhost:${PORT}`);
  console.log(`  ├─ Gateway: ${GATEWAY}`);
  console.log(`  ├─ Threads: ${threadCount} stored`);
  console.log(`  ├─ Uploads: ${UPLOADS_DIR}`);
  console.log(`  ├─ WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  └─ Ready`);
});
