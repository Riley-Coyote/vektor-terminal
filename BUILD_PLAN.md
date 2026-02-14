# Vektor Terminal — Production Build Plan

## Current State Audit

### What Exists ✅
- Custom Node.js server (server.mjs) on port 8088
- SSE streaming via Gateway chat completions API proxy
- Thread management (create, rename, delete, switch)
- localStorage persistence for threads
- Markdown-lite renderer (bold, italic, headers, code, lists, blockquotes, links, hr)
- Streaming cursor animation
- Auto-resize textarea
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Auto-naming threads from first message
- Responsive layout with sidebar
- Full monochrome design aesthetic (JetBrains Mono, amber accent)
- Message fade-in animation

### What's Missing ❌
Everything below, organized by priority phase.

---

## Phase 1: Code Blocks (World-Class)
**Priority: HIGH — Most visible quality gap**

- [ ] **Syntax highlighting** — Add highlight.js (CDN) with custom monochrome theme
- [ ] **Language label** — Parse ` ```typescript ` and show label in header bar
- [ ] **Code block header bar** — Top bar with language name (left) + copy button (right)
- [ ] **Copy code button** — One-click copy to clipboard with checkmark feedback
- [ ] **Line numbers** (optional toggle)
- [ ] **Code block max-height** — Scroll for long blocks (480px)
- [ ] **Better code block styling** — Darker bg, rounded corners, subtle border
- [ ] **Inline code styling** — Distinct from surrounding text

## Phase 2: Message Actions
**Priority: HIGH — Core ChatGPT parity**

- [ ] **Copy message** — Button to copy full message text
- [ ] **Edit message** — Click to edit user message, re-sends from that point
- [ ] **Regenerate response** — Re-run last assistant response
- [ ] **Delete message** — Remove individual messages
- [ ] **Message hover actions bar** — Show action buttons on hover (copy, edit, regen, delete)
- [ ] **Stop generation** — Abort button during streaming (AbortController)
- [ ] **Message timestamps** — Show on hover or in metadata

## Phase 3: File & Image Support
**Priority: HIGH — Key functionality gap**

- [ ] **Image upload** — Drag & drop or button in compose area
- [ ] **File upload** — Attach files to messages
- [ ] **Image display in messages** — Render uploaded/generated images inline
- [ ] **Image paste** — Ctrl+V to paste images from clipboard
- [ ] **File preview** — Show file name/size for non-image attachments
- [ ] **Download button** — For generated files/images

## Phase 4: Markdown Rendering (Full)
**Priority: MEDIUM — Quality improvement**

- [ ] **Tables** — Full markdown table rendering with styled headers
- [ ] **Nested lists** — Proper indentation for sub-items
- [ ] **Numbered lists** — Ordered list rendering
- [ ] **Task lists** — `- [x]` checkbox rendering
- [ ] **Strikethrough** — `~~text~~` support
- [ ] **Footnotes** — If needed
- [ ] **Math/LaTeX** — KaTeX for math expressions
- [ ] **Better paragraph handling** — Fix edge cases in current renderer
- [ ] **Sanitization** — DOMPurify for XSS protection

## Phase 5: Conversation Management
**Priority: MEDIUM — Power user features**

- [ ] **Message branching** — Fork conversation from any message, tree navigation
- [ ] **Branch indicator** — Show which branch you're on, navigate between branches
- [ ] **Search within thread** — Find text in current conversation
- [ ] **Search across threads** — Global search across all conversations
- [ ] **Thread folders/tags** — Organize conversations
- [ ] **Thread export** — Export as markdown, JSON, or PDF
- [ ] **Thread import** — Import conversation history
- [ ] **Pin messages** — Bookmark important messages within a thread
- [ ] **Conversation summary** — Auto-generate summary for long threads

## Phase 6: Input & Compose Enhancements
**Priority: MEDIUM — UX polish**

- [ ] **Voice input** — Speech-to-text via Web Speech API or Whisper
- [ ] **Slash commands** — `/model`, `/clear`, `/export`, `/search`
- [ ] **@ mentions** — Reference other threads or memories
- [ ] **Markdown preview** — Toggle preview of what you're typing
- [ ] **Draft persistence** — Save unsent drafts per thread
- [ ] **Multi-line paste handling** — Clean paste from code editors
- [ ] **Character/token count** — Show in compose area

## Phase 7: Model & Agent Control
**Priority: MEDIUM — OpenClaw parity**

- [ ] **Model selector** — Switch between claude-opus, sonnet, etc. mid-conversation
- [ ] **Agent selector** — Switch between main, anima, custom agents
- [ ] **System prompt editor** — Edit per-thread system prompts
- [ ] **Temperature/parameter controls** — Advanced model settings
- [ ] **Token usage display** — Show input/output tokens per message
- [ ] **Cost tracker** — Running cost estimate per thread

## Phase 8: UI Polish & Micro-Interactions
**Priority: MEDIUM — Premium feel**

- [ ] **Thinking indicator** — Animated indicator while agent processes (not just cursor)
- [ ] **Tool use display** — Show when tools are being called (like Clawdbot control UI)
- [ ] **Smooth scroll** — Animated scroll-to-bottom
- [ ] **Message appear animation** — Refine existing fade-in
- [ ] **Skeleton loading** — For thread list, message history
- [ ] **Toast notifications** — For copy, error, success feedback
- [ ] **Keyboard shortcuts panel** — `?` to show all shortcuts
- [ ] **Focus mode** — Hide sidebar, full-width messages
- [ ] **Font size controls** — Accessibility slider
- [ ] **Theme toggle** — Dark (current) / light / auto

## Phase 9: Persistence & Sync
**Priority: LOW — Infrastructure**

- [ ] **Server-side storage** — Move from localStorage to file/DB persistence
- [ ] **Gateway session sync** — Tie threads to Clawdbot sessions for memory continuity
- [ ] **Cross-device sync** — Access threads from any device
- [ ] **Backup/restore** — Export/import all data
- [ ] **Session handoff** — Continue conversation started in Telegram/other channels

## Phase 10: Advanced Features
**Priority: LOW — Differentiation**

- [ ] **Artifacts panel** — Side panel for code, documents, visualizations
- [ ] **Split view** — Chat + artifact side by side
- [ ] **Share conversation** — Generate shareable link
- [ ] **Collaborative mode** — Multiple users in same thread
- [ ] **Plugin system** — Extensible UI components
- [ ] **Keyboard-first navigation** — Full keyboard control (vim-style)
- [ ] **Command palette** — Cmd+K for quick actions
- [ ] **PWA support** — Install as desktop/mobile app

---

## Implementation Order

### Sprint 1 (Today/Tomorrow): Code Blocks + Stop Button
1. Add highlight.js via CDN
2. Create monochrome syntax theme
3. Parse language from code fences
4. Build code block header (language + copy)
5. Add stop generation button (AbortController)
6. Improve code block CSS

### Sprint 2: Message Actions
1. Message hover actions bar
2. Copy message
3. Edit user message (re-send from edit point)
4. Regenerate last response
5. Delete message
6. Message timestamps

### Sprint 3: File/Image Upload
1. Drag & drop zone in compose
2. File input button
3. Clipboard paste for images
4. Image preview before send
5. Image display in messages
6. Multimodal API integration (vision)

### Sprint 4: Full Markdown + Branching
1. Replace markdown-lite with marked.js or similar
2. Add DOMPurify
3. Tables, nested lists, task lists
4. Message branching data model
5. Branch navigation UI
6. Thread search

### Sprint 5: Polish & Advanced
1. Model/agent selector
2. Tool use display
3. Thinking indicator
4. Toast notifications
5. Keyboard shortcuts
6. Focus mode

---

## Tech Stack Decisions

| Component | Choice | Reason |
|-----------|--------|--------|
| Syntax highlighting | highlight.js | Lightweight, 190+ languages, easy custom themes |
| Markdown rendering | marked.js | Fast, extensible, good defaults |
| Sanitization | DOMPurify | Industry standard XSS protection |
| Math rendering | KaTeX | Faster than MathJax, good enough |
| Icons | Inline SVG | No dependencies, matches aesthetic |
| State management | Vanilla JS | Keep it simple, no framework overhead |
| Storage (Phase 1) | localStorage | Already working |
| Storage (Phase 2) | File-based via server | Persistent, git-friendly |

## Architecture Notes

- **Single HTML file** — Keep the current architecture, add CDN imports
- **No build step** — No webpack/vite/etc needed
- **Progressive enhancement** — Each feature is additive, nothing breaks existing
- **Server proxy** — All API calls go through server.mjs (already handles SSE)
- **Gateway API** — Chat completions endpoint with streaming (already working)
