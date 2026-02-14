import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// ── Paths ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8088', 10);
const GATEWAY = 'http://127.0.0.1:18789';

const DATA_DIR = join(__dirname, 'data');
const THREADS_DIR = join(DATA_DIR, 'threads');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

// ── Clawdbot / System Paths ──
const HOME = process.env.HOME || '/Users/rileycoyote';
const CLAWDBOT_DIR = join(HOME, '.clawdbot');
const CLAWD_DIR = join(HOME, 'clawd');
const MEMORY_DIR = join(CLAWD_DIR, 'memory');
const REPOS_DIR = join(HOME, 'Documents/Repositories');

// Skill directories (three sources)
const SKILL_DIRS = [
  { path: join(CLAWDBOT_DIR, 'skills'), source: 'clawdhub' },
  { path: join(CLAWD_DIR, 'skills'), source: 'custom' },
  { path: join(HOME, '.nvm/versions/node/v22.19.0/lib/node_modules/clawdbot/skills'), source: 'builtin' },
];

// Session directories (per agent)
const AGENTS_DIR = join(CLAWDBOT_DIR, 'agents');

// Ensure directories exist
[DATA_DIR, THREADS_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach(dir => {
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
        participants: data.participants || ['main'],
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
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
    const { id: clientId, name, mode, participants } = req.body;
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
      participants: participants || ['main'],
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

// PATCH /api/threads/:id — update thread metadata
app.patch('/api/threads/:id', (req, res) => {
  const thread = readThread(req.params.id);
  if (!thread) return errorResponse(res, 404, 'not_found', 'Thread not found');

  const { name, mode, participants } = req.body;
  if (name !== undefined) thread.name = name;
  if (mode !== undefined) thread.mode = mode;
  if (participants !== undefined) thread.participants = participants;

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
  if (req.headers['x-clawdbot-agent-id']) headers['x-clawdbot-agent-id'] = req.headers['x-clawdbot-agent-id'];

  // Session key: prefer explicit header, then try to extract from body for thread mapping
  if (req.headers['x-clawdbot-session-key']) {
    headers['x-clawdbot-session-key'] = req.headers['x-clawdbot-session-key'];
  } else {
    // Try to extract thread context from request body to map to session
    try {
      if (body.length) {
        const parsed = JSON.parse(body.toString());
        const user = parsed.user || '';
        // If user field contains thread ID, resolve the session key
        if (user.startsWith('vektor-terminal-thread_')) {
          const threadId = user.replace('vektor-terminal-', '');
          const thread = readThread(threadId);
          if (thread?.sessionKey) {
            headers['x-clawdbot-session-key'] = thread.sessionKey;
          }
        }
      }
    } catch { /* ignore parse errors */ }
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

// POST /api/canvas — save artifact
app.post('/api/canvas', (req, res) => {
  try {
    const { id, title, content, type, language } = req.body;
    if (!content) return errorResponse(res, 400, 'bad_request', 'content is required');
    
    const artifactId = id || ('artifact_' + Date.now() + '_' + uuidv4().slice(0, 8));
    const artifact = {
      id: artifactId,
      title: title || 'Untitled',
      content,
      type: type || 'html',
      language: language || 'html',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    writeFileSync(join(ARTIFACTS_DIR, `${artifactId}.json`), JSON.stringify(artifact, null, 2), 'utf-8');
    res.status(201).json(artifact);
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// GET /api/canvas/:id — serve artifact HTML in iframe-safe way
app.get('/api/canvas/:id', (req, res) => {
  try {
    const fp = join(ARTIFACTS_DIR, `${req.params.id}.json`);
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
        return { id: data.id, title: data.title, type: data.type, language: data.language, updatedAt: data.updatedAt };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ artifacts });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

// DELETE /api/canvas/:id — delete artifact
app.delete('/api/canvas/:id', (req, res) => {
  try {
    const fp = join(ARTIFACTS_DIR, `${req.params.id}.json`);
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
    const skills = [];
    for (const { path: dir, source } of SKILL_DIRS) {
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
    for (const { path: dir, source } of SKILL_DIRS) {
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

async function buildSessionIndex() {
  const now = Date.now();
  if (sessionIndexCache && (now - sessionIndexCacheTime) < SESSION_CACHE_TTL) {
    return sessionIndexCache;
  }

  const agents = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name) : [];

  const sessions = [];
  const parsePromises = [];

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

  sessionIndexCache = { sessions, agents };
  sessionIndexCacheTime = now;
  return sessionIndexCache;
}

app.get('/api/sessions', async (req, res) => {
  try {
    const { agent, limit = 50, offset = 0, search } = req.query;
    const { sessions: allSessions, agents } = await buildSessionIndex();

    let filtered = allSessions;
    if (agent) filtered = filtered.filter(s => s.agent === agent);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(s =>
        s.preview.toLowerCase().includes(q) || s.id.includes(q)
      );
    }

    const total = filtered.length;
    const paged = filtered.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ sessions: paged, total, agents });
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

const CRON_JOBS_FILE = join(CLAWDBOT_DIR, 'cron', 'jobs.json');
const CRON_RUNS_DIR = join(CLAWDBOT_DIR, 'cron', 'runs');

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

function discoverProjects() {
  const projects = [];

  // Scan ~/clawd for project dirs (has package.json, pyproject.toml, Cargo.toml, or .git)
  const projectMarkers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'setup.py'];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'memory', 'memories', 'skills', 'design-refs', 'design-agents', 'research', 'ops', 'canvas', 'chatgpt-v2-designs', 'polyphonic-ref', 'x-drafts']);

  if (existsSync(CLAWD_DIR)) {
    for (const entry of readdirSync(CLAWD_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const dir = join(CLAWD_DIR, entry.name);
      const hasMarker = projectMarkers.some(m => existsSync(join(dir, m)));
      const hasGit = existsSync(join(dir, '.git'));

      if (hasMarker || hasGit) {
        const project = {
          id: entry.name,
          name: entry.name,
          path: dir,
          workspace: 'clawd',
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

  // Scan ~/Documents/Repositories
  if (existsSync(REPOS_DIR)) {
    for (const entry of readdirSync(REPOS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(REPOS_DIR, entry.name);
      const hasMarker = projectMarkers.some(m => existsSync(join(dir, m)));
      const hasGit = existsSync(join(dir, '.git'));

      if (hasMarker || hasGit) {
        const project = {
          id: `repos-${entry.name}`,
          name: entry.name,
          path: dir,
          workspace: 'repositories',
          markers: [],
        };

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

        if (hasGit) {
          project.markers.push('git');
          try {
            const remote = execSync('git remote get-url origin 2>/dev/null', { cwd: dir, encoding: 'utf-8' }).trim();
            project.gitRemote = remote;
          } catch {}
          try {
            const lastCommit = execSync('git log -1 --format="%H|%s|%ai" 2>/dev/null', { cwd: dir, encoding: 'utf-8' }).trim();
            const [hash, message, date] = lastCommit.split('|');
            project.lastCommit = { hash: hash?.slice(0, 8), message, date };
          } catch {}
        }

        try {
          const stat = statSync(dir);
          project.modifiedAt = stat.mtime.toISOString();
        } catch {}

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
    const projects = discoverProjects();
    res.json({ projects, total: projects.length });
  } catch (err) {
    errorResponse(res, 500, 'internal_error', err.message);
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const projects = discoverProjects();
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

app.get('/api/memory', (req, res) => {
  try {
    const files = [];

    // Main MEMORY.md
    const mainMemory = join(CLAWD_DIR, 'MEMORY.md');
    if (existsSync(mainMemory)) {
      const stat = statSync(mainMemory);
      files.push({
        id: 'MEMORY.md',
        name: 'MEMORY.md',
        path: mainMemory,
        type: 'core',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    // Memory directory files
    if (existsSync(MEMORY_DIR)) {
      for (const entry of readdirSync(MEMORY_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Scan subdirectories like reflections/
          const subDir = join(MEMORY_DIR, entry.name);
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
          const fp = join(MEMORY_DIR, entry.name);
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
    // Handle nested paths like reflections/file.md
    const id = req.params.id;
    let filePath;

    if (id === 'MEMORY.md') {
      filePath = join(CLAWD_DIR, 'MEMORY.md');
    } else {
      filePath = join(MEMORY_DIR, id);
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
    const filePath = join(MEMORY_DIR, req.params.dir, req.params.file);
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
        status.gateway = await gwRes.json();
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
// 6. SERVER STARTUP
// ══════════════════════════════════════════════

// Keep-alive settings for SSE
server.keepAliveTimeout = 300_000;
server.headersTimeout = 305_000;
server.timeout = 0; // No socket timeout for SSE

// Graceful shutdown
function shutdown() {
  console.log('\n⏀ Shutting down...');
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
