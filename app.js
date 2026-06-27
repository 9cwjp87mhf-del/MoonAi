/**
 * MoonAi – app.js
 * Full client-side AI chatbot powered by WebLLM (Mistral / SmolLM2).
 * No backend. No login. Runs 100% in the browser.
 */

/* ============================================================
   CONSTANTS & CONFIGURATION
   ============================================================ */

const CONFIG = {
  // WebLLM model: SmolLM2-1.7B is compact, fast, and works well without WebGPU
  // Falls back gracefully on unsupported hardware.
  MODEL_ID: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",

  // Rate limiting: max messages per window
  RATE_LIMIT_MAX: 150,
  RATE_LIMIT_WINDOW_MS: 3 * 60 * 60 * 1000, // 3 hours

  // Image upload
  MAX_IMAGE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  ACCEPTED_IMAGE_TYPES: ["image/jpeg", "image/jpg", "image/png"],

  // LocalStorage keys
  LS_CHATS: "moonai_chats",
  LS_ACTIVE_CHAT: "moonai_active_chat",
  LS_RATE: "moonai_rate",

  // System prompt
  SYSTEM_PROMPT: `You are MoonAi, a helpful, friendly, and thoughtful AI assistant. You run entirely in the user's browser — no data is sent to any server. Be concise but thorough. Format responses with markdown when helpful (code blocks, lists, bold). If a user asks something harmful, illegal, or inappropriate, politely decline by saying: "Diese Anfrage verstößt gegen meine Sicherheitsrichtlinien." Never break this rule.`,

  // Tabu patterns (checked client-side before sending to model)
  TABU_PATTERNS: [
    /how\s+to\s+(make|build|create|synthesize)\s+(bomb|explosive|weapon|poison|drug|meth|fentanyl)/i,
    /suicide\s+(method|how|way|instructions)/i,
    /child\s+(porn|abuse|molest|exploit)/i,
    /hack\s+(bank|government|military|hospital)/i,
    /(kill|murder|shoot|stab)\s+(someone|a person|my|the)/i,
    /nazi|white\s+supremac/i,
  ],

  TABU_RESPONSE: "Diese Anfrage verstößt gegen meine Sicherheitsrichtlinien. Ich kann dabei leider nicht helfen.",
};

/* ============================================================
   STATE
   ============================================================ */

const state = {
  engine: null,           // WebLLM engine instance
  modelLoaded: false,     // Whether model finished loading
  modelLoading: false,    // Whether model is currently loading
  isGenerating: false,    // Whether AI is currently generating
  chats: {},              // { [chatId]: { id, title, messages: [], createdAt } }
  activeChatId: null,     // Currently open chat ID
  pendingImage: null,     // { dataUrl, file } or null
  webllmReady: false,     // Whether WebLLM CDN script loaded
  abortController: null,  // For cancelling generation
};

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */

function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatDateGroup(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Heute";
  if (d.toDateString() === yesterday.toDateString()) return "Gestern";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "short" });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitize(html) {
  if (typeof DOMPurify !== "undefined") {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p", "br", "b", "strong", "i", "em", "u", "s", "del",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "blockquote", "pre", "code",
        "table", "thead", "tbody", "tr", "th", "td",
        "a", "hr", "span", "div", "img",
      ],
      ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt", "title"],
    });
  }
  return html;
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);

  marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
  });

  let html = marked.parse(text);

  // Wrap code blocks with header bar
  html = html.replace(
    /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, lang, code) => {
      const langLabel = lang || "code";
      const safeCode = code; // already escaped by marked
      return `
        <pre>
          <div class="code-block-header">
            <span class="code-lang-label">${escapeHtml(langLabel)}</span>
            <button class="btn-copy-code" data-code="${safeCode.replace(/"/g, "&quot;")}">Kopieren</button>
          </div>
          <code class="language-${escapeHtml(langLabel)}">${safeCode}</code>
        </pre>`;
    }
  );

  return sanitize(html);
}

function applySyntaxHighlighting(container) {
  if (typeof hljs === "undefined") return;
  container.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });
}

/* ============================================================
   LOCAL STORAGE – PERSISTENCE
   ============================================================ */

function loadChats() {
  try {
    const raw = localStorage.getItem(CONFIG.LS_CHATS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Validate structure
    if (typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    console.warn("MoonAi: Failed to load chats from LocalStorage:", e);
    return {};
  }
}

function saveChats() {
  try {
    localStorage.setItem(CONFIG.LS_CHATS, JSON.stringify(state.chats));
  } catch (e) {
    if (e.name === "QuotaExceededError") {
      showToast("Speicher fast voll. Alte Chats werden entfernt.", "error");
      pruneOldestChats();
      try {
        localStorage.setItem(CONFIG.LS_CHATS, JSON.stringify(state.chats));
      } catch (e2) {
        console.error("MoonAi: Cannot save chats, storage full.", e2);
      }
    } else {
      console.error("MoonAi: Failed to save chats:", e);
    }
  }
}

function pruneOldestChats() {
  const ids = Object.keys(state.chats).sort(
    (a, b) => (state.chats[a].createdAt || 0) - (state.chats[b].createdAt || 0)
  );
  // Remove oldest 20% of chats
  const toRemove = Math.max(1, Math.floor(ids.length * 0.2));
  for (let i = 0; i < toRemove; i++) {
    delete state.chats[ids[i]];
  }
}

function loadActiveChat() {
  try {
    return localStorage.getItem(CONFIG.LS_ACTIVE_CHAT) || null;
  } catch (e) {
    return null;
  }
}

function saveActiveChat(id) {
  try {
    if (id) {
      localStorage.setItem(CONFIG.LS_ACTIVE_CHAT, id);
    } else {
      localStorage.removeItem(CONFIG.LS_ACTIVE_CHAT);
    }
  } catch (e) {
    console.warn("MoonAi: Failed to save active chat:", e);
  }
}

/* ============================================================
   RATE LIMITING
   ============================================================ */

function getRateData() {
  try {
    const raw = localStorage.getItem(CONFIG.LS_RATE);
    if (!raw) return { count: 0, windowStart: Date.now() };
    const data = JSON.parse(raw);
    if (typeof data.count !== "number" || typeof data.windowStart !== "number") {
      return { count: 0, windowStart: Date.now() };
    }
    return data;
  } catch (e) {
    return { count: 0, windowStart: Date.now() };
  }
}

function saveRateData(data) {
  try {
    localStorage.setItem(CONFIG.LS_RATE, JSON.stringify(data));
  } catch (e) {
    console.warn("MoonAi: Failed to save rate data:", e);
  }
}

function checkRateLimit() {
  const data = getRateData();
  const now = Date.now();

  // Reset window if expired
  if (now - data.windowStart > CONFIG.RATE_LIMIT_WINDOW_MS) {
    const fresh = { count: 0, windowStart: now };
    saveRateData(fresh);
    return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX };
  }

  if (data.count >= CONFIG.RATE_LIMIT_MAX) {
    const resetInMs = CONFIG.RATE_LIMIT_WINDOW_MS - (now - data.windowStart);
    const resetInMin = Math.ceil(resetInMs / 60000);
    return { allowed: false, remaining: 0, resetInMin };
  }

  return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - data.count };
}

function incrementRateCount() {
  const data = getRateData();
  const now = Date.now();

  if (now - data.windowStart > CONFIG.RATE_LIMIT_WINDOW_MS) {
    saveRateData({ count: 1, windowStart: now });
  } else {
    saveRateData({ count: data.count + 1, windowStart: data.windowStart });
  }
}

/* ============================================================
   CHAT MANAGEMENT
   ============================================================ */

function createChat() {
  const id = generateId();
  state.chats[id] = {
    id,
    title: "Neuer Chat",
    messages: [],
    createdAt: Date.now(),
  };
  saveChats();
  return id;
}

function getActiveChat() {
  if (!state.activeChatId) return null;
  return state.chats[state.activeChatId] || null;
}

function setActiveChat(id) {
  state.activeChatId = id;
  saveActiveChat(id);
}

function deleteChat(id) {
  if (!state.chats[id]) return;
  delete state.chats[id];
  saveChats();

  if (state.activeChatId === id) {
    const ids = Object.keys(state.chats);
    if (ids.length > 0) {
      // Activate most recent
      const sorted = ids.sort(
        (a, b) => (state.chats[b].createdAt || 0) - (state.chats[a].createdAt || 0)
      );
      setActiveChat(sorted[0]);
    } else {
      const newId = createChat();
      setActiveChat(newId);
    }
  }
}

function addMessageToChat(chatId, role, content, imageDataUrl = null) {
  if (!state.chats[chatId]) return null;
  const msg = {
    id: generateId(),
    role,
    content,
    imageDataUrl: imageDataUrl || null,
    timestamp: Date.now(),
  };
  state.chats[chatId].messages.push(msg);
  return msg;
}

async function autoTitleChat(chatId, firstUserMessage) {
  if (!state.chats[chatId]) return;
  if (state.chats[chatId].title !== "Neuer Chat") return;
  if (!state.modelLoaded || !state.engine) return;

  try {
    const prompt = `Erstelle einen sehr kurzen Titel (3-4 Wörter, kein Punkt am Ende) für ein Gespräch, das mit dieser Nachricht beginnt: "${firstUserMessage.slice(0, 200)}"`;
    const resp = await state.engine.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 20,
      temperature: 0.4,
    });
    const raw = resp.choices?.[0]?.message?.content?.trim() || "";
    const title = raw.replace(/["""]/g, "").replace(/\.$/, "").trim().slice(0, 50);
    if (title && title.length > 1) {
      state.chats[chatId].title = title;
      saveChats();
      renderSidebar();
      const topbar = document.getElementById("topbar-title");
      if (topbar && state.activeChatId === chatId) {
        topbar.textContent = title;
      }
    }
  } catch (e) {
    // Non-critical: title generation failed silently
    console.warn("MoonAi: Auto-title failed:", e);
  }
}

/* ============================================================
   CONTENT SAFETY – Client-side Tabu Check
   ============================================================ */

function checkTabuContent(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  for (const pattern of CONFIG.TABU_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

/* ============================================================
   WEBLLM – Model Loading & AI Generation
   ============================================================ */

async function waitForWebLLM() {
  return new Promise((resolve, reject) => {
    if (window.webllm) {
      resolve(window.webllm);
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error("WebLLM konnte nicht geladen werden. Bitte prüfe deine Internetverbindung."));
    }, 30000);
    window.addEventListener("webllm-ready", () => {
      clearTimeout(timeout);
      resolve(window.webllm);
    }, { once: true });
  });
}

function showModelLoader(show) {
  const el = document.getElementById("model-loader");
  if (!el) return;
  if (show) {
    el.classList.remove("hidden");
    updateEmptyState(false);
  } else {
    el.classList.add("hidden");
  }
}

function updateProgress(progress) {
  const fill = document.getElementById("progress-fill");
  const pct = document.getElementById("loader-pct");
  const subtitle = document.getElementById("loader-subtitle");
  const track = document.getElementById("progress-track");

  const pctValue = Math.min(100, Math.max(0, Math.round(progress.progress * 100)));

  if (fill) fill.style.width = `${pctValue}%`;
  if (pct) pct.textContent = `${pctValue}%`;
  if (track) track.setAttribute("aria-valuenow", pctValue);
  if (subtitle && progress.text) {
    subtitle.textContent = progress.text.slice(0, 80);
  }
}

function setStatusDot(state_str) {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-label");
  if (!dot || !label) return;

  dot.className = "status-dot";
  switch (state_str) {
    case "loading":
      dot.classList.add("loading");
      label.textContent = "Lädt…";
      break;
    case "ready":
      dot.classList.add("ready");
      label.textContent = "Bereit";
      break;
    case "error":
      dot.classList.add("error");
      label.textContent = "Fehler";
      break;
    default:
      label.textContent = "Nicht geladen";
  }
}

async function initializeModel() {
  if (state.modelLoaded || state.modelLoading) return;
  state.modelLoading = true;

  showModelLoader(true);
  setStatusDot("loading");
  setSendButtonState(false);

  try {
    // Wait for WebLLM CDN module
    const webllm = await waitForWebLLM();

    // Check WebGPU availability
    const hasWebGPU = navigator.gpu !== undefined;
    if (!hasWebGPU) {
      console.info("MoonAi: WebGPU not available, WebLLM will use WebAssembly fallback.");
    }

    // Create engine with progress callback
    state.engine = await webllm.CreateMLCEngine(CONFIG.MODEL_ID, {
      initProgressCallback: (progress) => {
        updateProgress(progress);
      },
    });

    state.modelLoaded = true;
    state.modelLoading = false;
    showModelLoader(false);
    setStatusDot("ready");
    setSendButtonState(true);
    updateEmptyState(true);
    showToast("KI-Modell geladen ✓", "success");

  } catch (err) {
    state.modelLoading = false;
    state.modelLoaded = false;
    showModelLoader(false);
    setStatusDot("error");

    console.error("MoonAi: Model initialization error:", err);

    const errMsg = buildErrorMessage(err);
    appendErrorMessage(errMsg);
    updateEmptyState(true);
  }
}

function buildErrorMessage(err) {
  const msg = err?.message || String(err);

  if (msg.includes("WebGPU") || msg.includes("GPU")) {
    return "⚠️ WebGPU wird von deinem Browser nicht unterstützt. Versuche Chrome 113+ oder Edge 113+. Das Modell konnte nicht geladen werden.";
  }
  if (msg.includes("memory") || msg.includes("Memory")) {
    return "⚠️ Nicht genug Arbeitsspeicher (RAM) um das KI-Modell zu laden. Schließe andere Tabs und versuche es erneut.";
  }
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("Network")) {
    return "⚠️ Netzwerkfehler: Das Modell konnte nicht heruntergeladen werden. Bitte prüfe deine Internetverbindung und lade die Seite neu.";
  }
  if (msg.includes("WebLLM konnte nicht geladen")) {
    return `⚠️ ${msg}`;
  }
  return `⚠️ Das KI-Modell konnte nicht geladen werden. Fehler: ${msg.slice(0, 200)}`;
}

async function generateResponse(userText, imageDataUrl = null) {
  if (!state.modelLoaded || !state.engine) {
    appendErrorMessage("Das KI-Modell ist noch nicht geladen. Bitte warte einen Moment.");
    return;
  }

  if (state.isGenerating) {
    showToast("Eine Antwort wird bereits generiert.", "error");
    return;
  }

  const chat = getActiveChat();
  if (!chat) return;

  // Build messages for the API call
  const contextMessages = [
    { role: "system", content: CONFIG.SYSTEM_PROMPT },
  ];

  // Include last N messages for context (avoid token overflow)
  const historyToInclude = chat.messages.slice(-20);
  for (const m of historyToInclude) {
    if (m.role === "user" || m.role === "assistant") {
      contextMessages.push({ role: m.role, content: m.content || "" });
    }
  }

  state.isGenerating = true;
  state.abortController = new AbortController();
  setSendButtonState(false);

  // Add AI placeholder bubble
  const aiMsgEl = appendAiMessagePlaceholder();

  try {
    let fullResponse = "";

    const stream = await state.engine.chat.completions.create({
      messages: contextMessages,
      stream: true,
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
    });

    for await (const chunk of stream) {
      if (state.abortController?.signal.aborted) break;

      const delta = chunk.choices?.[0]?.delta?.content || "";
      fullResponse += delta;

      // Stream render
      updateAiMessageStream(aiMsgEl, fullResponse);
    }

    // Finalize
    finalizeAiMessage(aiMsgEl, fullResponse);

    // Save to state
    const aiMsg = addMessageToChat(state.activeChatId, "assistant", fullResponse);
    saveChats();

    // Auto-title on first exchange
    if (chat.messages.filter((m) => m.role === "user").length === 1) {
      autoTitleChat(state.activeChatId, userText);
    }

  } catch (err) {
    if (err?.name === "AbortError" || state.abortController?.signal.aborted) {
      finalizeAiMessage(aiMsgEl, aiMsgEl._partialText || "_(Generierung abgebrochen)_");
    } else {
      console.error("MoonAi: Generation error:", err);
      aiMsgEl.remove();
      appendErrorMessage(`Fehler bei der Antwortgenerierung: ${err?.message || String(err)}`);
    }
  } finally {
    state.isGenerating = false;
    state.abortController = null;
    setSendButtonState(true);
    scrollToBottom();
  }
}

/* ============================================================
   UI – RENDERING FUNCTIONS
   ============================================================ */

function updateEmptyState(show) {
  const el = document.getElementById("empty-state");
  if (!el) return;
  const hasMessages = getActiveChat()?.messages?.length > 0;
  el.style.display = (show && !hasMessages) ? "" : "none";
}

function setSendButtonState(enabled) {
  const btn = document.getElementById("btn-send");
  const input = document.getElementById("chat-input");
  if (!btn) return;

  const hasText = input?.value?.trim().length > 0;
  const hasPendingImage = state.pendingImage !== null;

  if (!enabled || !state.modelLoaded) {
    btn.disabled = true;
  } else {
    btn.disabled = !(hasText || hasPendingImage);
  }
}

function scrollToBottom(smooth = true) {
  const chatArea = document.getElementById("chat-area");
  if (!chatArea) return;
  requestAnimationFrame(() => {
    chatArea.scrollTo({
      top: chatArea.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
  });
}

/* ---------- Sidebar Rendering ---------- */

function renderSidebar() {
  const list = document.getElementById("chat-history-list");
  if (!list) return;

  list.innerHTML = "";

  const ids = Object.keys(state.chats).sort(
    (a, b) => (state.chats[b].createdAt || 0) - (state.chats[a].createdAt || 0)
  );

  if (ids.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty-msg";
    empty.textContent = "Noch keine Chats. Starte eine Konversation!";
    list.appendChild(empty);
    return;
  }

  let lastGroup = "";
  for (const id of ids) {
    const chat = state.chats[id];
    const group = formatDateGroup(chat.createdAt || Date.now());

    if (group !== lastGroup) {
      const groupEl = document.createElement("div");
      groupEl.className = "sidebar-history-label";
      groupEl.style.paddingTop = "10px";
      groupEl.style.paddingBottom = "2px";
      groupEl.textContent = group;
      list.appendChild(groupEl);
      lastGroup = group;
    }

    const item = document.createElement("div");
    item.className = "history-item" + (id === state.activeChatId ? " active" : "");
    item.setAttribute("role", "listitem");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", `Chat: ${chat.title}`);

    const icon = document.createElement("span");
    icon.className = "history-item-icon";
    icon.textContent = "💬";

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = chat.title || "Neuer Chat";

    const delBtn = document.createElement("button");
    delBtn.className = "history-item-delete";
    delBtn.setAttribute("aria-label", "Chat löschen");
    delBtn.setAttribute("title", "Chat löschen");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showConfirmModal("Chat löschen?", `"${chat.title}" wird dauerhaft gelöscht.`, () => {
        deleteChat(id);
        renderSidebar();
        renderChatMessages();
        renderTopbarTitle();
      });
    });

    item.appendChild(icon);
    item.appendChild(title);
    item.appendChild(delBtn);

    item.addEventListener("click", () => {
      setActiveChat(id);
      renderSidebar();
      renderChatMessages();
      renderTopbarTitle();
      closeMobileSidebar();
    });

    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        item.click();
      }
    });

    list.appendChild(item);
  }
}

function renderTopbarTitle() {
  const topbar = document.getElementById("topbar-title");
  if (!topbar) return;
  const chat = getActiveChat();
  topbar.textContent = chat ? chat.title : "MoonAi";
}

/* ---------- Chat Messages Rendering ---------- */

function renderChatMessages() {
  const container = document.getElementById("messages-container");
  if (!container) return;

  container.innerHTML = "";

  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) {
    updateEmptyState(true);
    return;
  }

  updateEmptyState(false);

  for (const msg of chat.messages) {
    const el = buildMessageElement(msg.role, msg.content, msg.imageDataUrl, msg.timestamp);
    container.appendChild(el);
  }

  applySyntaxHighlighting(container);
  scrollToBottom(false);
}

function buildMessageElement(role, content, imageDataUrl = null, timestamp = Date.now()) {
  const row = document.createElement("div");
  row.className = `message-row ${role === "user" ? "user" : "ai"}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.setAttribute("aria-label", "MoonAi");
    avatar.textContent = "🌙";
    row.appendChild(avatar);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  // Image attachment
  if (imageDataUrl) {
    const img = document.createElement("img");
    img.className = "msg-image";
    img.src = imageDataUrl;
    img.alt = "Hochgeladenes Bild";
    img.loading = "lazy";
    bubble.appendChild(img);
  }

  const textEl = document.createElement("div");
  textEl.className = "msg-text";

  if (role === "user") {
    textEl.innerHTML = sanitize(escapeHtml(content).replace(/\n/g, "<br>"));
  } else {
    textEl.innerHTML = renderMarkdown(content);
  }

  bubble.appendChild(textEl);

  const timeEl = document.createElement("div");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTime(timestamp);
  bubble.appendChild(timeEl);

  row.appendChild(bubble);
  return row;
}

function appendUserMessage(text, imageDataUrl = null) {
  const container = document.getElementById("messages-container");
  if (!container) return;

  const el = buildMessageElement("user", text, imageDataUrl, Date.now());
  container.appendChild(el);
  updateEmptyState(false);
  scrollToBottom();
}

function appendAiMessagePlaceholder() {
  const container = document.getElementById("messages-container");
  if (!container) return null;

  const row = document.createElement("div");
  row.className = "message-row ai";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = "🌙";
  row.appendChild(avatar);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  const textEl = document.createElement("div");
  textEl.className = "msg-text streaming-cursor";
  textEl.textContent = "";
  bubble.appendChild(textEl);

  row.appendChild(bubble);
  container.appendChild(row);
  scrollToBottom();

  row._textEl = textEl;
  row._partialText = "";

  return row;
}

function updateAiMessageStream(rowEl, fullText) {
  if (!rowEl || !rowEl._textEl) return;
  rowEl._partialText = fullText;
  rowEl._textEl.innerHTML = renderMarkdown(fullText);
  rowEl._textEl.classList.add("streaming-cursor");
  scrollToBottom(false);
}

function finalizeAiMessage(rowEl, fullText) {
  if (!rowEl || !rowEl._textEl) return;
  rowEl._textEl.innerHTML = renderMarkdown(fullText);
  rowEl._textEl.classList.remove("streaming-cursor");

  const timestamp = document.createElement("div");
  timestamp.className = "msg-time";
  timestamp.textContent = formatTime(Date.now());
  rowEl.querySelector(".msg-bubble").appendChild(timestamp);

  applySyntaxHighlighting(rowEl);
  setupCopyButtons(rowEl);
  scrollToBottom();
}

function appendErrorMessage(text) {
  const container = document.getElementById("messages-container");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "message-row ai";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = "🌙";
  row.appendChild(avatar);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble error-bubble";
  bubble.textContent = text;
  row.appendChild(bubble);

  container.appendChild(row);
  updateEmptyState(false);
  scrollToBottom();
}

/* ---------- Code Copy Buttons ---------- */

function setupCopyButtons(container) {
  container.querySelectorAll(".btn-copy-code").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.getAttribute("data-code") || "";
      const decoded = code.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      try {
        await navigator.clipboard.writeText(decoded);
        const original = btn.textContent;
        btn.textContent = "Kopiert!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 2000);
      } catch (e) {
        showToast("Kopieren fehlgeschlagen.", "error");
      }
    });
  });
}

/* ---------- Toast Notification ---------- */

let toastTimeout = null;

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toast.classList.remove("show", "toast-error", "toast-success");
  }

  toast.textContent = message;
  toast.className = "toast";
  if (type === "error") toast.classList.add("toast-error");
  if (type === "success") toast.classList.add("toast-success");

  // Force reflow
  void toast.offsetWidth;
  toast.classList.remove("hidden");
  toast.classList.add("show");

  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 200);
  }, 3200);
}

/* ---------- Confirm Modal ---------- */

let confirmCallback = null;

function showConfirmModal(title, body, onConfirm) {
  const overlay = document.getElementById("confirm-modal");
  const titleEl = document.getElementById("modal-title");
  const bodyEl = document.getElementById("modal-body");

  if (!overlay) return;

  titleEl.textContent = title;
  bodyEl.textContent = body;
  confirmCallback = onConfirm;
  overlay.classList.remove("hidden");
}

function hideConfirmModal() {
  const overlay = document.getElementById("confirm-modal");
  if (overlay) overlay.classList.add("hidden");
  confirmCallback = null;
}

/* ---------- Sidebar Mobile ---------- */

function openMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const hamburger = document.getElementById("btn-hamburger");

  sidebar?.classList.add("mobile-open");
  overlay?.classList.remove("hidden");
  requestAnimationFrame(() => overlay?.classList.add("visible"));
  hamburger?.setAttribute("aria-expanded", "true");
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const hamburger = document.getElementById("btn-hamburger");

  sidebar?.classList.remove("mobile-open");
  overlay?.classList.remove("visible");
  hamburger?.setAttribute("aria-expanded", "false");

  setTimeout(() => {
    if (!overlay?.classList.contains("visible")) {
      overlay?.classList.add("hidden");
    }
  }, 300);
}

/* ============================================================
   IMAGE UPLOAD
   ============================================================ */

function handleImageSelect(file) {
  if (!file) return;

  if (!CONFIG.ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    showToast("Ungültiges Format. Nur JPG und PNG werden unterstützt.", "error");
    return;
  }

  if (file.size > CONFIG.MAX_IMAGE_SIZE_BYTES) {
    showToast("Bild zu groß. Maximal 5 MB erlaubt.", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    state.pendingImage = { dataUrl, file };
    showImagePreview(dataUrl);
    setSendButtonState(true);
  };
  reader.onerror = () => {
    showToast("Fehler beim Lesen des Bildes.", "error");
  };
  reader.readAsDataURL(file);
}

function showImagePreview(dataUrl) {
  const bar = document.getElementById("image-preview-bar");
  const thumb = document.getElementById("img-thumb");
  if (!bar || !thumb) return;

  thumb.src = dataUrl;
  bar.classList.remove("hidden");
}

function clearPendingImage() {
  state.pendingImage = null;
  const bar = document.getElementById("image-preview-bar");
  const thumb = document.getElementById("img-thumb");
  const fileInput = document.getElementById("file-input");
  if (bar) bar.classList.add("hidden");
  if (thumb) thumb.src = "";
  if (fileInput) fileInput.value = "";
  setSendButtonState(!!document.getElementById("chat-input")?.value?.trim());
}

/* ============================================================
   MESSAGE SENDING – MAIN FLOW
   ============================================================ */

async function handleSendMessage() {
  const input = document.getElementById("chat-input");
  if (!input) return;

  const text = input.value.trim();
  const imageDataUrl = state.pendingImage?.dataUrl || null;

  if (!text && !imageDataUrl) return;

  if (!state.modelLoaded) {
    showToast("Das KI-Modell wird noch geladen. Bitte warte.", "error");
    return;
  }

  if (state.isGenerating) {
    showToast("Bitte warte, bis die aktuelle Antwort fertig ist.", "error");
    return;
  }

  // Rate limit check
  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    const notice = document.createElement("div");
    notice.className = "rate-limit-notice";
    notice.textContent = `⏱️ Nachrichtenlimit erreicht (${CONFIG.RATE_LIMIT_MAX} Nachrichten / 3 Stunden). Bitte warte ${rateCheck.resetInMin} Minuten.`;
    const container = document.getElementById("messages-container");
    container?.appendChild(notice);
    updateEmptyState(false);
    scrollToBottom();
    return;
  }

  // Tabu check
  if (checkTabuContent(text)) {
    input.value = "";
    autoResizeTextarea(input);
    setSendButtonState(false);

    addMessageToChat(state.activeChatId, "user", text, null);
    appendUserMessage(text, null);

    const tabuResp = CONFIG.TABU_RESPONSE;
    addMessageToChat(state.activeChatId, "assistant", tabuResp);
    saveChats();

    const aiEl = appendAiMessagePlaceholder();
    setTimeout(() => finalizeAiMessage(aiEl, tabuResp), 100);
    return;
  }

  // Clear input
  input.value = "";
  autoResizeTextarea(input);
  setSendButtonState(false);

  // Clear image preview
  const imageCopy = imageDataUrl;
  clearPendingImage();

  // Ensure chat exists
  if (!state.activeChatId || !state.chats[state.activeChatId]) {
    const newId = createChat();
    setActiveChat(newId);
    renderSidebar();
  }

  // Save & render user message
  const finalText = text || "(Bild gesendet)";
  addMessageToChat(state.activeChatId, "user", finalText, imageCopy);
  saveChats();
  appendUserMessage(finalText, imageCopy);

  // Increment rate counter
  incrementRateCount();

  // Generate AI response
  await generateResponse(finalText, imageCopy);

  renderSidebar();
  renderTopbarTitle();
}

/* ============================================================
   TEXTAREA AUTO-RESIZE
   ============================================================ */

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

/* ============================================================
   EVENT LISTENERS – INITIALIZATION
   ============================================================ */

function setupEventListeners() {
  // === Send button ===
  const btnSend = document.getElementById("btn-send");
  if (btnSend) {
    btnSend.addEventListener("click", () => {
      handleSendMessage();
    });
  }

  // === Chat input – keyboard ===
  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });

    chatInput.addEventListener("input", () => {
      autoResizeTextarea(chatInput);
      setSendButtonState(true);
    });

    chatInput.addEventListener("paste", () => {
      // Small delay to let paste complete
      setTimeout(() => {
        autoResizeTextarea(chatInput);
        setSendButtonState(true);
      }, 10);
    });
  }

  // === New Chat button ===
  const btnNewChat = document.getElementById("btn-new-chat");
  if (btnNewChat) {
    btnNewChat.addEventListener("click", () => {
      const newId = createChat();
      setActiveChat(newId);
      renderSidebar();
      renderChatMessages();
      renderTopbarTitle();
      closeMobileSidebar();
      chatInput?.focus();
    });
  }

  // === Image upload button ===
  const btnImageUpload = document.getElementById("btn-image-upload");
  const fileInput = document.getElementById("file-input");

  if (btnImageUpload && fileInput) {
    btnImageUpload.addEventListener("click", () => {
      if (!state.modelLoaded) {
        showToast("Bitte warte, bis das KI-Modell geladen ist.", "error");
        return;
      }
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) handleImageSelect(file);
    });
  }

  // === Remove image button ===
  const btnRemoveImage = document.getElementById("btn-remove-image");
  if (btnRemoveImage) {
    btnRemoveImage.addEventListener("click", () => {
      clearPendingImage();
    });
  }

  // === Hamburger (mobile) ===
  const btnHamburger = document.getElementById("btn-hamburger");
  if (btnHamburger) {
    btnHamburger.addEventListener("click", () => {
      const sidebar = document.getElementById("sidebar");
      const isOpen = sidebar?.classList.contains("mobile-open");
      if (isOpen) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    });
  }

  // === Sidebar overlay (mobile close) ===
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => {
      closeMobileSidebar();
    });
  }

  // === Confirm modal buttons ===
  const modalCancel = document.getElementById("modal-cancel");
  const modalConfirm = document.getElementById("modal-confirm");

  if (modalCancel) {
    modalCancel.addEventListener("click", () => {
      hideConfirmModal();
    });
  }

  if (modalConfirm) {
    modalConfirm.addEventListener("click", () => {
      if (typeof confirmCallback === "function") {
        confirmCallback();
      }
      hideConfirmModal();
    });
  }

  // === Modal overlay – close on outside click ===
  const confirmModal = document.getElementById("confirm-modal");
  if (confirmModal) {
    confirmModal.addEventListener("click", (e) => {
      if (e.target === confirmModal) {
        hideConfirmModal();
      }
    });
  }

  // === Hint cards ===
  const hintCards = document.querySelectorAll(".hint-card");
  hintCards.forEach((card) => {
    card.addEventListener("click", () => {
      const text = card.textContent.trim();
      if (chatInput) {
        if (text.includes("Stelle eine Frage")) {
          chatInput.value = "Was ist Quantenmechanik?";
        } else if (text.includes("Lade ein Bild")) {
          fileInput?.click();
          return;
        } else if (text.includes("Bitte um Code")) {
          chatInput.value = "Schreibe eine Python-Funktion, die Fibonacci-Zahlen berechnet.";
        }
        autoResizeTextarea(chatInput);
        setSendButtonState(true);
        chatInput.focus();
      }
    });
  });

  // === Drag & Drop image on chat area ===
  const chatArea = document.getElementById("chat-area");
  if (chatArea) {
    chatArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    chatArea.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file && CONFIG.ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        handleImageSelect(file);
      } else if (file) {
        showToast("Nur JPG/PNG Bilder werden unterstützt.", "error");
      }
    });
  }

  // === Paste image from clipboard ===
  document.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          handleImageSelect(file);
          break;
        }
      }
    }
  });

  // === Keyboard shortcuts ===
  document.addEventListener("keydown", (e) => {
    // Escape closes modal / mobile sidebar
    if (e.key === "Escape") {
      hideConfirmModal();
      closeMobileSidebar();
    }
  });

  // === Resize – recalculate things ===
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const isMobile = window.innerWidth <= 720;
      if (!isMobile) {
        closeMobileSidebar();
      }
    }, 100);
  });
}

/* ============================================================
   SERVICE WORKER (PWA)
   ============================================================ */

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .then((reg) => {
          console.info("MoonAi: Service Worker registered:", reg.scope);
        })
        .catch((err) => {
          // Non-critical: PWA install still works without SW in some browsers
          console.warn("MoonAi: Service Worker registration failed:", err);
        });
    });
  }
}

/* ============================================================
   BOOT / MAIN
   ============================================================ */

async function boot() {
  // Load chats from LocalStorage
  state.chats = loadChats();

  // Ensure at least one chat exists
  const existingIds = Object.keys(state.chats);
  if (existingIds.length === 0) {
    const newId = createChat();
    setActiveChat(newId);
  } else {
    const savedActive = loadActiveChat();
    if (savedActive && state.chats[savedActive]) {
      setActiveChat(savedActive);
    } else {
      // Set most recent
      const sorted = existingIds.sort(
        (a, b) => (state.chats[b].createdAt || 0) - (state.chats[a].createdAt || 0)
      );
      setActiveChat(sorted[0]);
    }
  }

  // Setup event listeners
  setupEventListeners();

  // Render initial UI
  renderSidebar();
  renderChatMessages();
  renderTopbarTitle();

  // Register Service Worker for PWA
  registerServiceWorker();

  // Start loading AI model
  await initializeModel();
}

// Start when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
