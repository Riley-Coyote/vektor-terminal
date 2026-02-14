import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

// ── Paths ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8088;
const GATEWAY = 'http://127.0.0.1:18789';

const DATA_DIR = join(__dirname, 'data');
const THREADS_DIR = join(DATA_DIR, 'threads');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

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
// 4. STATIC FILE SERVING
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
