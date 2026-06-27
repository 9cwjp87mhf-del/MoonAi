// ═══════════════════════════════════════════════════════════════════════
//  MoonAi — app.js
//  Dual-purpose file:
//    • When required by Node.js → Express server (CommonJS)
//    • When loaded as <script type="module"> in browser → Frontend SPA logic
// ═══════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
//  DETECT ENVIRONMENT
// ─────────────────────────────────────────────────────────────────────
const IS_SERVER = typeof process !== 'undefined' &&
                  typeof process.versions !== 'undefined' &&
                  typeof process.versions.node !== 'undefined' &&
                  typeof window === 'undefined';

if (IS_SERVER) {
  // ════════════════════════════════════════════════════════════════════
  //  SERVER — Node.js / Express
  // ════════════════════════════════════════════════════════════════════
  'use strict';

  const express     = require('express');
  const helmet      = require('helmet');
  const cors        = require('cors');
  const rateLimit   = require('express-rate-limit');
  const bcrypt      = require('bcrypt');
  const jwt         = require('jsonwebtoken');
  const multer      = require('multer');
  const path        = require('path');
  const fs          = require('fs');
  const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
  require('dotenv').config();

  const app  = express();
  const PORT = process.env.PORT || 3000;
  const JWT_SECRET = process.env.JWT_SECRET || 'moonai_super_secret_jwt_key_change_in_prod';
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;

  // ── In-memory stores (replace with DB in production) ──
  // users:   { email → { email, hashedPassword, id, username } }
  // chats:   { userId → { chatId → { title, messages: [] } } }
  // chatIds: counter
  const users   = new Map();
  const chats   = new Map();
  let   chatCounter = 1;

  // ── Gemini AI client ──
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const MODEL = 'gemini-2.0-flash-lite';

  const SAFETY_SETTINGS = [
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  ];

  const SAFETY_FALLBACK = 'Ich kann dir bei diesem Thema leider nicht weiterhelfen, da es gegen meine Sicherheitsrichtlinien verstößt.';

  // ── Multer (in-memory, max 5 MB) ──
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/jpg', 'image/png'];
      allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Nur JPG und PNG erlaubt.'));
    },
  });

  // ────────────────────────────────────────────────────────────────────
  //  MIDDLEWARE
  // ────────────────────────────────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:   ["'self'"],
        scriptSrc:    ["'self'", 'cdnjs.cloudflare.com'],
        styleSrc:     ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
        fontSrc:      ["'self'", 'cdnjs.cloudflare.com'],
        imgSrc:       ["'self'", 'data:', 'blob:'],
        connectSrc:   ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: ALLOWED_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Serve static files (index.html, styles.css, app.js, manifest.json)
  app.use(express.static(path.join(__dirname)));

  // ────────────────────────────────────────────────────────────────────
  //  RATE LIMITS
  // ────────────────────────────────────────────────────────────────────
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    keyGenerator: (req) => req.ip,
  });

  const chatLimiter = rateLimit({
    windowMs: 3 * 60 * 60 * 1000, // 3 hours
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Du hast dein Nachrichtenlimit (150 pro 3 Stunden) erreicht. Bitte warte etwas.' },
    keyGenerator: (req) => req.user?.id || req.ip,
  });

  // ────────────────────────────────────────────────────────────────────
  //  AUTH MIDDLEWARE
  // ────────────────────────────────────────────────────────────────────
  function verifyToken(req, res, next) {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).json({ error: 'Kein Token vorhanden.' });
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      return res.status(401).json({ error: 'Token ungültig oder abgelaufen.' });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  INPUT SANITIZATION
  // ────────────────────────────────────────────────────────────────────
  function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;')
      .trim()
      .slice(0, 8000);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ────────────────────────────────────────────────────────────────────
  //  AUTH ROUTES
  // ────────────────────────────────────────────────────────────────────

  // POST /api/auth/register
  app.post('/api/auth/register', loginLimiter, async (req, res) => {
    try {
      const email    = sanitizeText(req.body.email || '').toLowerCase();
      const password = (req.body.password || '').trim();

      if (!isValidEmail(email))          return res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
      if (password.length < 8)           return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein.' });
      if (users.has(email))              return res.status(409).json({ error: 'Diese E-Mail ist bereits registriert.' });

      const hashed  = await bcrypt.hash(password, 10);
      const userId  = `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const username = email.split('@')[0];

      users.set(email, { email, hashedPassword: hashed, id: userId, username });
      chats.set(userId, new Map());

      const token = jwt.sign({ id: userId, email, username }, JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({ token, username });
    } catch (err) {
      console.error('Register error:', err);
      return res.status(500).json({ error: 'Interner Serverfehler.' });
    }
  });

  // POST /api/auth/login
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
      const email    = sanitizeText(req.body.email || '').toLowerCase();
      const password = (req.body.password || '').trim();

      const user = users.get(email);
      if (!user) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

      const match = await bcrypt.compare(password, user.hashedPassword);
      if (!match) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });

      const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, username: user.username });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Interner Serverfehler.' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  //  CHAT ROUTES
  // ────────────────────────────────────────────────────────────────────

  // GET /api/chats — list all chats for user
  app.get('/api/chats', verifyToken, (req, res) => {
    const userChats = chats.get(req.user.id) || new Map();
    const list = Array.from(userChats.entries())
      .map(([id, c]) => ({ id, title: c.title || 'Neuer Chat' }))
      .reverse();
    return res.json(list);
  });

  // GET /api/chats/:chatId — get messages for a chat
  app.get('/api/chats/:chatId', verifyToken, (req, res) => {
    const userChats = chats.get(req.user.id);
    if (!userChats) return res.status(404).json({ error: 'Keine Chats gefunden.' });
    const chat = userChats.get(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
    return res.json({ id: req.params.chatId, title: chat.title, messages: chat.messages });
  });

  // DELETE /api/chats/:chatId — delete a chat
  app.delete('/api/chats/:chatId', verifyToken, (req, res) => {
    const userChats = chats.get(req.user.id);
    if (!userChats) return res.status(404).json({ error: 'Keine Chats gefunden.' });
    const existed = userChats.delete(req.params.chatId);
    if (!existed) return res.status(404).json({ error: 'Chat nicht gefunden.' });
    return res.json({ success: true });
  });

  // POST /api/chats/new — create new empty chat, return chatId
  app.post('/api/chats/new', verifyToken, (req, res) => {
    const userId = req.user.id;
    if (!chats.has(userId)) chats.set(userId, new Map());
    const chatId = `c_${chatCounter++}_${Date.now()}`;
    chats.get(userId).set(chatId, { title: 'Neuer Chat', messages: [] });
    return res.json({ chatId });
  });

  // POST /api/chat/stream — send a message and stream the response
  app.post('/api/chat/stream', verifyToken, chatLimiter, upload.single('image'), async (req, res) => {
    try {
      const userId  = req.user.id;
      let { message, chatId } = req.body;

      message = sanitizeText(message || '');
      if (!message && !req.file) return res.status(400).json({ error: 'Nachricht oder Bild erforderlich.' });

      // Ensure user chat map exists
      if (!chats.has(userId)) chats.set(userId, new Map());
      const userChats = chats.get(userId);

      // Ensure chat exists
      if (!chatId || !userChats.has(chatId)) {
        chatId = `c_${chatCounter++}_${Date.now()}`;
        userChats.set(chatId, { title: 'Neuer Chat', messages: [] });
      }
      const chat = userChats.get(chatId);
      const isFirstMessage = chat.messages.length === 0;

      // Build parts for this turn
      const userParts = [];
      if (req.file) {
        userParts.push({
          inlineData: {
            data: req.file.buffer.toString('base64'),
            mimeType: req.file.mimetype,
          },
        });
      }
      if (message) userParts.push({ text: message });

      // Build history in Gemini format
      const history = chat.messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      }));

      // ── SSE Setup ──
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      // Send chatId back first (frontend may need it)
      sendEvent({ type: 'chatId', chatId });

      // ── Store user message ──
      const userMsgText = message || '[Bild]';
      chat.messages.push({ role: 'user', content: userMsgText });

      // ── Call Gemini with streaming ──
      let fullAiText = '';

      try {
        const geminiChat = genAI.chats.create({
          model: MODEL,
          history,
          config: { safetySettings: SAFETY_SETTINGS },
        });

        const stream = await geminiChat.sendMessageStream({ parts: userParts });

        for await (const chunk of stream) {
          const text = chunk.text?.() ?? '';
          if (text) {
            fullAiText += text;
            sendEvent({ type: 'chunk', text });
          }
        }
      } catch (aiError) {
        // Handle safety blocks or API errors gracefully
        const errorMsg = aiError?.message || '';
        const isSafetyBlock =
          errorMsg.includes('SAFETY') ||
          errorMsg.includes('blocked') ||
          (aiError?.response?.promptFeedback?.blockReason);

        const fallback = isSafetyBlock ? SAFETY_FALLBACK : 'Es ist ein Fehler aufgetreten. Bitte versuche es erneut.';
        fullAiText = fallback;
        sendEvent({ type: 'chunk', text: fallback });
        console.error('Gemini error:', aiError?.message || aiError);
      }

      // ── Store AI message ──
      chat.messages.push({ role: 'assistant', content: fullAiText });

      // ── Generate title for first message (background, non-blocking) ──
      if (isFirstMessage && message) {
        (async () => {
          try {
            const titlePrompt = `Erstelle einen prägnanten deutschen Titel (3-4 Wörter) für dieses Gespräch. 
Nutzeranfrage: "${message.slice(0, 200)}"
Antworte NUR mit dem Titel, ohne Anführungszeichen oder Erklärungen.`;

            const titleResult = await genAI.models.generateContent({
              model: MODEL,
              contents: [{ role: 'user', parts: [{ text: titlePrompt }] }],
            });
            const titleText = titleResult.text?.().trim() || 'Neues Gespräch';
            chat.title = titleText.slice(0, 50);
            // Notify frontend of new title
            sendEvent({ type: 'title', chatId, title: chat.title });
          } catch {
            chat.title = message.slice(0, 35);
            sendEvent({ type: 'title', chatId, title: chat.title });
          }
        })();
      }

      sendEvent({ type: 'done' });
      res.end();
    } catch (err) {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Interner Fehler beim Streaming.' });
      } else {
        try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Serverfehler' })}\n\n`); res.end(); } catch {}
      }
    }
  });

  // ── Catch-all → serve index.html ──
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  // ── Error handler ──
  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Bild zu groß (max. 5 MB).' });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Interner Serverfehler.' });
  });

  app.listen(PORT, () => {
    console.log(`\n🌙 MoonAi Server läuft auf http://localhost:${PORT}\n`);
  });

} else {
  // ════════════════════════════════════════════════════════════════════
  //  FRONTEND — Browser SPA
  // ════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────
  //  STATE
  // ─────────────────────────────────────
  let authToken    = localStorage.getItem('moonai_token') || null;
  let currentUser  = (() => { try { return JSON.parse(localStorage.getItem('moonai_user')) || null; } catch { return null; } })();
  let activeChatId = null;
  let pendingImage = null;   // { file, dataUrl }
  let isStreaming  = false;

  // ─────────────────────────────────────
  //  DOM REFERENCES
  // ─────────────────────────────────────
  const authScreen       = document.getElementById('auth-screen');
  const app_             = document.getElementById('app');
  const authEmail        = document.getElementById('auth-email');
  const authPassword     = document.getElementById('auth-password');
  const authSubmitBtn    = document.getElementById('auth-submit-btn');
  const authToggleBtn    = document.getElementById('auth-toggle-btn');
  const authSubtitle     = document.getElementById('auth-subtitle');
  const authError        = document.getElementById('auth-error');

  const sidebar          = document.getElementById('sidebar');
  const sidebarOverlay   = document.getElementById('sidebar-overlay');
  const newChatBtn       = document.getElementById('new-chat-btn');
  const chatHistoryList  = document.getElementById('chat-history-list');
  const userNameDisplay  = document.getElementById('user-name-display');
  const logoutBtn        = document.getElementById('logout-btn');
  const hamburgerBtn     = document.getElementById('hamburger-btn');
  const sidebarCloseBtn  = document.getElementById('sidebar-close-btn');

  const welcomeScreen    = document.getElementById('welcome-screen');
  const chatMessages     = document.getElementById('chat-messages');
  const chatInput        = document.getElementById('chat-input');
  const sendBtn          = document.getElementById('send-btn');
  const attachBtn        = document.getElementById('attach-btn');
  const fileInput        = document.getElementById('file-input');
  const imagePreviewCont = document.getElementById('image-preview-container');
  const imagePreview     = document.getElementById('image-preview');
  const removeImageBtn   = document.getElementById('remove-image-btn');

  // ─────────────────────────────────────
  //  AUTH MODE TOGGLE
  // ─────────────────────────────────────
  let isRegisterMode = false;

  authToggleBtn.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    if (isRegisterMode) {
      authSubtitle.textContent = 'Erstelle dein Konto';
      authSubmitBtn.textContent = 'Konto erstellen';
      authToggleBtn.textContent = 'Anmelden';
      authToggleBtn.previousSibling.textContent = 'Bereits registriert? ';
    } else {
      authSubtitle.textContent = 'Willkommen zurück';
      authSubmitBtn.textContent = 'Anmelden';
      authToggleBtn.textContent = 'Konto erstellen';
      authToggleBtn.previousSibling.textContent = 'Noch kein Konto? ';
    }
    hideAuthError();
  });

  // ─────────────────────────────────────
  //  AUTH HELPERS
  // ─────────────────────────────────────
  function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.remove('hidden');
  }

  function hideAuthError() {
    authError.textContent = '';
    authError.classList.add('hidden');
  }

  authSubmitBtn.addEventListener('click', handleAuth);
  authEmail.addEventListener('keydown', e => e.key === 'Enter' && authPassword.focus());
  authPassword.addEventListener('keydown', e => e.key === 'Enter' && handleAuth());

  async function handleAuth() {
    hideAuthError();
    const email    = authEmail.value.trim();
    const password = authPassword.value.trim();

    if (!email || !password) { showAuthError('Bitte E-Mail und Passwort eingeben.'); return; }
    if (password.length < 8) { showAuthError('Passwort muss mindestens 8 Zeichen lang sein.'); return; }

    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = 'Bitte warten…';

    const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
    try {
      const res  = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showAuthError(data.error || 'Unbekannter Fehler.');
      } else {
        authToken   = data.token;
        currentUser = { username: data.username, email };
        localStorage.setItem('moonai_token', authToken);
        localStorage.setItem('moonai_user', JSON.stringify(currentUser));
        launchApp();
      }
    } catch {
      showAuthError('Verbindung zum Server fehlgeschlagen.');
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.textContent = isRegisterMode ? 'Konto erstellen' : 'Anmelden';
    }
  }

  // ─────────────────────────────────────
  //  APP INIT
  // ─────────────────────────────────────
  function launchApp() {
    authScreen.classList.add('hidden');
    app_.classList.remove('hidden');
    userNameDisplay.textContent = currentUser?.username || 'Nutzer';
    loadChatHistory();
    autoResizeTextarea();
    chatInput.focus();
  }

  function logout() {
    authToken    = null;
    currentUser  = null;
    activeChatId = null;
    pendingImage = null;
    localStorage.removeItem('moonai_token');
    localStorage.removeItem('moonai_user');
    app_.classList.add('hidden');
    authScreen.classList.remove('hidden');
    authEmail.value    = '';
    authPassword.value = '';
    chatMessages.innerHTML = '';
    chatHistoryList.innerHTML = '';
    hideAuthError();
  }

  logoutBtn.addEventListener('click', logout);

  // ─────────────────────────────────────
  //  SIDEBAR / MOBILE
  // ─────────────────────────────────────
  hamburgerBtn.addEventListener('click', openSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);
  sidebarCloseBtn.addEventListener('click', closeSidebar);

  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('active');
    hamburgerBtn.classList.add('hidden');
    sidebarCloseBtn.classList.remove('hidden');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    hamburgerBtn.classList.remove('hidden');
    sidebarCloseBtn.classList.add('hidden');
  }

  // ─────────────────────────────────────
  //  CHAT HISTORY
  // ─────────────────────────────────────
  async function loadChatHistory() {
    try {
      const res  = await apiFetch('/api/chats');
      const list = await res.json();
      renderChatList(list);
    } catch { /* silent */ }
  }

  function renderChatList(list) {
    chatHistoryList.innerHTML = '';
    list.forEach(c => appendChatListItem(c.id, c.title));
  }

  function appendChatListItem(chatId, title) {
    // Remove existing item with same id if present
    const existing = chatHistoryList.querySelector(`[data-chat-id="${chatId}"]`);
    if (existing) existing.remove();

    const li = document.createElement('li');
    li.className = 'chat-list-item';
    li.dataset.chatId = chatId;
    if (chatId === activeChatId) li.classList.add('active');

    li.innerHTML = `
      <span class="chat-list-item-title">${escapeHtml(title)}</span>
      <button class="chat-list-item-delete" title="Chat löschen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.chat-list-item-delete')) return;
      openChat(chatId);
    });

    li.querySelector('.chat-list-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chatId, li);
    });

    chatHistoryList.prepend(li);
  }

  function setActiveListItem(chatId) {
    chatHistoryList.querySelectorAll('.chat-list-item').forEach(el => {
      el.classList.toggle('active', el.dataset.chatId === chatId);
    });
  }

  async function deleteChat(chatId, liEl) {
    try {
      await apiFetch(`/api/chats/${chatId}`, 'DELETE');
      liEl.remove();
      if (activeChatId === chatId) {
        activeChatId = null;
        showWelcomeScreen();
      }
    } catch { /* silent */ }
  }

  async function openChat(chatId) {
    if (chatId === activeChatId) { closeSidebar(); return; }
    activeChatId = chatId;
    setActiveListItem(chatId);
    closeSidebar();

    try {
      const res  = await apiFetch(`/api/chats/${chatId}`);
      const data = await res.json();
      renderFullChat(data.messages || []);
    } catch {
      showWelcomeScreen();
    }
  }

  function renderFullChat(messages) {
    welcomeScreen.classList.add('hidden');
    chatMessages.classList.remove('hidden');
    chatMessages.innerHTML = '';

    messages.forEach(m => {
      if (m.role === 'user') {
        appendUserMessage(m.content, null);
      } else {
        appendAiMessage(m.content);
      }
    });
    scrollToBottom();
  }

  // ─────────────────────────────────────
  //  NEW CHAT
  // ─────────────────────────────────────
  newChatBtn.addEventListener('click', startNewChat);

  async function startNewChat() {
    try {
      const res    = await apiFetch('/api/chats/new', 'POST');
      const { chatId } = await res.json();
      activeChatId = chatId;
      appendChatListItem(chatId, 'Neuer Chat');
      setActiveListItem(chatId);
      showWelcomeScreen();
      closeSidebar();
      clearImagePreview();
      chatInput.value = '';
      autoResizeTextarea();
      chatInput.focus();
    } catch { /* silent */ }
  }

  function showWelcomeScreen() {
    chatMessages.classList.add('hidden');
    chatMessages.innerHTML = '';
    welcomeScreen.classList.remove('hidden');
  }

  // ─────────────────────────────────────
  //  IMAGE UPLOAD
  // ─────────────────────────────────────
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert('Bild zu groß. Maximal 5 MB erlaubt.');
      fileInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingImage = { file, dataUrl: ev.target.result };
      imagePreview.src = ev.target.result;
      imagePreviewCont.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  removeImageBtn.addEventListener('click', clearImagePreview);

  function clearImagePreview() {
    pendingImage = null;
    imagePreview.src = '';
    imagePreviewCont.classList.add('hidden');
  }

  // ─────────────────────────────────────
  //  SEND MESSAGE
  // ─────────────────────────────────────
  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    if (isStreaming) return;
    const text = chatInput.value.trim();
    if (!text && !pendingImage) return;

    // If no active chat, create one first
    if (!activeChatId) {
      try {
        const res = await apiFetch('/api/chats/new', 'POST');
        const { chatId } = await res.json();
        activeChatId = chatId;
        appendChatListItem(chatId, 'Neuer Chat');
        setActiveListItem(chatId);
      } catch { return; }
    }

    // Show chat area
    welcomeScreen.classList.add('hidden');
    chatMessages.classList.remove('hidden');

    // Append user message
    appendUserMessage(text, pendingImage?.dataUrl || null);

    // Clear inputs
    const imageFile = pendingImage?.file || null;
    chatInput.value = '';
    autoResizeTextarea();
    clearImagePreview();
    chatInput.focus();

    // Build form data
    const formData = new FormData();
    formData.append('message', text);
    formData.append('chatId', activeChatId);
    if (imageFile) formData.append('image', imageFile);

    // Show typing indicator
    const typingRow = appendTypingIndicator();
    isStreaming     = true;
    sendBtn.disabled = true;

    let aiRow   = null;
    let aiText  = '';

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Fehler' }));
        typingRow.remove();
        appendAiMessage(err.error || 'Ein Fehler ist aufgetreten.');
        return;
      }

      const reader = response.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            handleStreamEvent(evt, typingRow, { aiRowRef: (r) => { aiRow = r; }, aiText: () => aiText, setAiText: (t) => { aiText = t; } });
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      typingRow.remove();
      appendAiMessage('Verbindungsfehler. Bitte versuche es erneut.');
    } finally {
      isStreaming      = false;
      sendBtn.disabled = false;
    }
  }

  function handleStreamEvent(evt, typingRow, state) {
    if (evt.type === 'chatId') {
      activeChatId = evt.chatId;
      setActiveListItem(activeChatId);
    }

    if (evt.type === 'chunk') {
      if (typingRow.parentNode) typingRow.remove();

      if (!state.aiRowRef._row) {
        const row = createAiRow();
        chatMessages.appendChild(row);
        state.aiRowRef._row = row;
        state.aiRowRef(row);
      }

      const newText = state.aiText() + evt.text;
      state.setAiText(newText);
      const bubble = state.aiRowRef._row.querySelector('.message-bubble');
      if (bubble) bubble.innerHTML = renderMarkdown(newText);
      applyHighlight(bubble);
      scrollToBottom();
    }

    if (evt.type === 'title') {
      updateChatTitle(evt.chatId, evt.title);
    }

    if (evt.type === 'done') {
      if (typingRow.parentNode) typingRow.remove();
    }

    if (evt.type === 'error') {
      if (typingRow.parentNode) typingRow.remove();
      appendAiMessage(evt.message || 'Fehler beim Laden der Antwort.');
    }
  }

  // ─────────────────────────────────────
  //  MESSAGE RENDERING
  // ─────────────────────────────────────
  function appendUserMessage(text, imageDataUrl) {
    const row = document.createElement('div');
    row.className = 'message-row user-row';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (imageDataUrl) {
      const img = document.createElement('img');
      img.src = imageDataUrl;
      img.className = 'user-bubble-image';
      img.alt = 'Bild';
      bubble.appendChild(img);
    }

    if (text) {
      const p = document.createElement('p');
      p.textContent = text;
      bubble.appendChild(p);
    }

    row.appendChild(bubble);
    chatMessages.appendChild(row);
    scrollToBottom();
  }

  function createAiRow() {
    const row = document.createElement('div');
    row.className = 'message-row ai-row';
    row.innerHTML = `
      <div class="ai-avatar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </div>
      <div class="message-bubble"></div>
    `;
    return row;
  }

  function appendAiMessage(text) {
    const row    = createAiRow();
    const bubble = row.querySelector('.message-bubble');
    bubble.innerHTML = renderMarkdown(text);
    applyHighlight(bubble);
    chatMessages.appendChild(row);
    scrollToBottom();
    return row;
  }

  function appendTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'message-row ai-row';
    row.innerHTML = `
      <div class="ai-avatar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </div>
      <div class="typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    `;
    chatMessages.appendChild(row);
    scrollToBottom();
    return row;
  }

  // ─────────────────────────────────────
  //  MARKDOWN RENDERING
  // ─────────────────────────────────────
  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');

    // Configure marked
    marked.setOptions({
      gfm: true,
      breaks: true,
      highlight: null, // handled by hljs after render
    });

    // Custom renderer for code blocks
    const renderer = new marked.Renderer();
    renderer.code = (code, lang) => {
      const language = lang || 'plaintext';
      const uniqueId = `cb-${Math.random().toString(36).slice(2, 8)}`;
      return `
<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang-label">${escapeHtml(language)}</span>
    <button class="copy-code-btn" data-code-id="${uniqueId}">Kopieren</button>
  </div>
  <pre><code id="${uniqueId}" class="language-${escapeHtml(language)}">${escapeHtml(typeof code === 'object' ? code.text || '' : code)}</code></pre>
</div>`;
    };

    return marked.parse(text, { renderer });
  }

  function applyHighlight(container) {
    if (!container || typeof hljs === 'undefined') return;
    container.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });
    // Bind copy buttons
    container.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const codeId  = btn.dataset.codeId;
        const codeEl  = document.getElementById(codeId);
        if (!codeEl) return;
        navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
          btn.textContent = 'Kopiert!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Kopieren'; btn.classList.remove('copied'); }, 2000);
        });
      });
    });
  }

  // ─────────────────────────────────────
  //  CHAT TITLE UPDATE
  // ─────────────────────────────────────
  function updateChatTitle(chatId, title) {
    const li = chatHistoryList.querySelector(`[data-chat-id="${chatId}"]`);
    if (li) {
      const span = li.querySelector('.chat-list-item-title');
      if (span) span.textContent = title;
    }
  }

  // ─────────────────────────────────────
  //  TEXTAREA AUTO-RESIZE
  // ─────────────────────────────────────
  function autoResizeTextarea() {
    chatInput.style.height = 'auto';
    const newH = Math.min(chatInput.scrollHeight, 200);
    chatInput.style.height = `${newH}px`;
  }

  chatInput.addEventListener('input', autoResizeTextarea);

  // ─────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────
  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function apiFetch(url, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body) opts.body = body instanceof FormData ? body : JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    return res;
  }

  // ─────────────────────────────────────
  //  PWA SERVICE WORKER
  // ─────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ─────────────────────────────────────
  //  STARTUP
  // ─────────────────────────────────────
  if (authToken && currentUser) {
    launchApp();
  }
}
