/**
 * MoonAi – app.js
 * Client-side AI chatbot powered by WebLLM (Mistral via WebGPU/WASM).
 * All data stays on device. No network requests except model download & WebLLM CDN.
 *
 * Architecture:
 *  - Auth:        WebCrypto PBKDF2 hashing, LocalStorage persistence
 *  - Sessions:    LocalStorage-backed chat history per user
 *  - Rate limit:  LocalStorage sliding window (150 msgs / 3 hours)
 *  - AI Engine:   WebLLM (mlc-ai) via CDN import, streaming responses
 *  - Markdown:    marked.js + DOMPurify + highlight.js
 *  - Image:       Base64 inline, passed to multimodal prompt context
 *  - Safety:      Client-side blocklist for harmful requests
 */

// ─── WebLLM dynamic import ──────────────────────────────────────────────────
let webllmModule = null;
let engine = null;
let engineReady = false;

// ─── App state ───────────────────────────────────────────────────────────────
const APP_PREFIX      = "moonai_";
const USERS_KEY       = `${APP_PREFIX}users`;
const SESSION_KEY     = `${APP_PREFIX}session`;
const CHATS_KEY       = `${APP_PREFIX}chats`;
const RATE_KEY_PREFIX = `${APP_PREFIX}rate_`;

const RATE_LIMIT_MAX    = 150;
const RATE_WINDOW_MS    = 3 * 60 * 60 * 1000; // 3 hours
const MAX_IMG_BYTES     = 5 * 1024 * 1024;     // 5 MB
const MAX_CONTEXT_MSGS  = 20;                   // rolling context window

// Model configuration – using a compact, WebGPU-compatible model
const MODEL_ID = "Mistral-7B-Instruct-v0.3-q4f16_1-MLC";

// Safety blocklist – patterns that trigger a policy refusal
const SAFETY_PATTERNS = [
  /how\s+to\s+(make|build|create|synthesize)\s+(a\s+)?(bomb|weapon|drug|poison|explosive|malware|virus)/i,
  /child\s+(porn|sex|abuse|exploitation)/i,
  /(buy|sell)\s+(drugs|weapons|guns|cocaine|heroin|meth)/i,
  /hack\s+(into|system|password|account)/i,
  /suicide\s+(method|how\s+to|instructions)/i,
  /kill\s+(myself|yourself|someone|a\s+person)/i,
  /self\s*harm\s+(method|how\s+to)/i,
  /racial\s+slur|n.gger|f.ggot/i,
  /detailed\s+instructions\s+for\s+terrorism/i,
  /how\s+to\s+commit\s+(murder|rape|assault)/i,
];

const SAFETY_RESPONSE =
  "Diese Anfrage verstößt gegen meine Sicherheitsrichtlinien. Ich kann dabei leider nicht helfen. Wenn du in einer Notlage bist, wende dich bitte an eine Notfallhotline (z. B. Telefonseelsorge: 0800 111 0 111).";

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser     = null;
let currentChatId   = null;
let pendingImageB64 = null;   // base64 of uploaded image
let pendingImageType= null;   // mime type
let isGenerating    = false;
let abortController = null;

// ─── DOM references ───────────────────────────────────────────────────────────
const elAuthOverlay        = document.getElementById("auth-overlay");
const elApp                = document.getElementById("app");
const elTabLogin           = document.getElementById("tab-login");
const elTabRegister        = document.getElementById("tab-register");
const elPanelLogin         = document.getElementById("panel-login");
const elPanelRegister      = document.getElementById("panel-register");
const elLoginUsername      = document.getElementById("login-username");
const elLoginPassword      = document.getElementById("login-password");
const elLoginError         = document.getElementById("login-error");
const elBtnLogin           = document.getElementById("btn-login");
const elRegUsername        = document.getElementById("reg-username");
const elRegPassword        = document.getElementById("reg-password");
const elRegConfirm         = document.getElementById("reg-confirm");
const elRegError           = document.getElementById("reg-error");
const elBtnRegister        = document.getElementById("btn-register");
const elSidebar            = document.getElementById("sidebar");
const elSidebarOverlay     = document.getElementById("sidebar-overlay");
const elBtnOpenSidebar     = document.getElementById("btn-open-sidebar");
const elBtnCloseSidebar    = document.getElementById("btn-close-sidebar");
const elBtnNewChat         = document.getElementById("btn-new-chat");
const elChatHistoryList    = document.getElementById("chat-history-list");
const elSidebarUserInfo    = document.getElementById("sidebar-user-info");
const elBtnLogout          = document.getElementById("btn-logout");
const elTopbarTitle        = document.getElementById("topbar-title");
const elTopbarStatus       = document.getElementById("topbar-status");
const elStatusDot          = document.getElementById("status-dot");
const elStatusText         = document.getElementById("status-text");
const elModelLoadingBanner = document.getElementById("model-loading-banner");
const elLoadingDetail      = document.getElementById("loading-detail");
const elLoadingProgressBar = document.getElementById("loading-progress-bar");
const elLoadingProgressTxt = document.getElementById("loading-progress-text");
const elLoadingProgressbox = document.getElementById("loading-progressbar");
const elChatMessages       = document.getElementById("chat-messages");
const elWelcomeScreen      = document.getElementById("welcome-screen");
const elImagePreviewArea   = document.getElementById("image-preview-area");
const elImagePreviewThumb  = document.getElementById("image-preview-thumb");
const elImagePreviewName   = document.getElementById("image-preview-name");
const elBtnRemoveImage     = document.getElementById("btn-remove-image");
const elFileImageUpload    = document.getElementById("file-image-upload");
const elLabelImageUpload   = document.getElementById("label-image-upload");
const elChatInput          = document.getElementById("chat-input");
const elBtnSend            = document.getElementById("btn-send");
const elRateLimitWarning   = document.getElementById("rate-limit-warning");
const elRateLimitText      = document.getElementById("rate-limit-text");
const elToastContainer     = document.getElementById("toast-container");

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Generate a short random ID */
function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Show toast notification */
function showToast(message, type = "info", durationMs = 3500) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const iconMap = {
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };

  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${iconMap[type] || iconMap.info}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
  elToastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("toast-visible");
  });

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-hide");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, durationMs);
}

/** Escape HTML for safe insertion */
function escapeHtml(str) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

/** Deep clone via JSON */
function deepClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

/** Debounce helper */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** Safe LocalStorage get/set/remove */
const ls = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("localStorage.set failed:", e);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // silently fail
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  CRYPTO – WebCrypto PBKDF2 password hashing
// ═══════════════════════════════════════════════════════════════════════════════

async function hashPassword(password, saltHex = null) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const salt = saltHex
    ? hexToUint8Array(saltHex)
    : crypto.getRandomValues(new Uint8Array(16));

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 310000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const hashHex = uint8ArrayToHex(new Uint8Array(bits));
  const newSaltHex = saltHex || uint8ArrayToHex(salt);
  return `${newSaltHex}:${hashHex}`;
}

async function verifyPassword(password, storedHash) {
  try {
    const [saltHex] = storedHash.split(":");
    const recomputed = await hashPassword(password, saltHex);
    return timingSafeEqual(recomputed, storedHash);
  } catch {
    return false;
  }
}

function uint8ArrayToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH MODULE
// ═══════════════════════════════════════════════════════════════════════════════

function getUsers() {
  return ls.get(USERS_KEY) || {};
}

function saveUsers(users) {
  ls.set(USERS_KEY, users);
}

function getSession() {
  return ls.get(SESSION_KEY);
}

function saveSession(username) {
  ls.set(SESSION_KEY, { username, loggedInAt: Date.now() });
}

function clearSession() {
  ls.remove(SESSION_KEY);
}

async function registerUser(username, password) {
  if (!username || username.trim().length < 3) {
    throw new Error("Benutzername muss mindestens 3 Zeichen lang sein.");
  }
  if (!/^[a-zA-Z0-9_\-\.]{3,64}$/.test(username)) {
    throw new Error("Benutzername darf nur Buchstaben, Ziffern, _, - und . enthalten.");
  }
  if (!password || password.length < 8) {
    throw new Error("Passwort muss mindestens 8 Zeichen lang sein.");
  }
  if (password.length > 128) {
    throw new Error("Passwort ist zu lang (max. 128 Zeichen).");
  }

  const users = getUsers();
  const key = username.toLowerCase();

  if (users[key]) {
    throw new Error("Dieser Benutzername ist bereits vergeben.");
  }

  const hash = await hashPassword(password);
  users[key] = {
    username: username.trim(),
    passwordHash: hash,
    createdAt: Date.now(),
  };
  saveUsers(users);
}

async function loginUser(username, password) {
  if (!username || !password) {
    throw new Error("Bitte fülle alle Felder aus.");
  }

  const users = getUsers();
  const key = username.trim().toLowerCase();
  const user = users[key];

  if (!user) {
    throw new Error("Benutzername oder Passwort ist falsch.");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error("Benutzername oder Passwort ist falsch.");
  }

  return user.username;
}

function setButtonLoading(btn, loading) {
  const textSpan   = btn.querySelector(".btn-text");
  const spinnerSpan = btn.querySelector(".btn-spinner");
  if (!textSpan || !spinnerSpan) return;
  btn.disabled = loading;
  textSpan.style.opacity = loading ? "0.5" : "1";
  if (loading) {
    spinnerSpan.removeAttribute("hidden");
  } else {
    spinnerSpan.setAttribute("hidden", "");
  }
}

function showAuthError(el, msg) {
  el.textContent = msg;
  el.removeAttribute("hidden");
}

function clearAuthError(el) {
  el.textContent = "";
  el.setAttribute("hidden", "");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════

function getRateData(username) {
  return ls.get(`${RATE_KEY_PREFIX}${username}`) || { timestamps: [] };
}

function saveRateData(username, data) {
  ls.set(`${RATE_KEY_PREFIX}${username}`, data);
}

function checkRateLimit(username) {
  const now = Date.now();
  const data = getRateData(username);

  // Remove entries outside window
  data.timestamps = data.timestamps.filter(ts => now - ts < RATE_WINDOW_MS);

  if (data.timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = data.timestamps[0];
    const resetIn = Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 60000);
    return {
      allowed: false,
      remaining: 0,
      resetInMinutes: resetIn,
    };
  }

  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX - data.timestamps.length,
    resetInMinutes: 0,
  };
}

function recordMessage(username) {
  const now = Date.now();
  const data = getRateData(username);
  data.timestamps = data.timestamps.filter(ts => now - ts < RATE_WINDOW_MS);
  data.timestamps.push(now);
  saveRateData(username, data);
}

function updateRateLimitUI(username) {
  const result = checkRateLimit(username);
  if (!result.allowed) {
    elRateLimitWarning.removeAttribute("hidden");
    elRateLimitText.textContent = `Nachrichtenlimit erreicht (${RATE_LIMIT_MAX} pro 3 Stunden). Bitte warte noch ${result.resetInMinutes} Minute(n).`;
    elChatInput.disabled = true;
    elBtnSend.disabled = true;
    elFileImageUpload.disabled = true;
  } else {
    elRateLimitWarning.setAttribute("hidden", "");
    elChatInput.disabled = false;
    if (elChatInput.value.trim() || pendingImageB64) {
      elBtnSend.disabled = false;
    }
    elFileImageUpload.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

function getChatsKey(username) {
  return `${CHATS_KEY}_${username.toLowerCase()}`;
}

function getAllChats(username) {
  return ls.get(getChatsKey(username)) || {};
}

function saveAllChats(username, chats) {
  ls.set(getChatsKey(username), chats);
}

function createNewChat(username) {
  const chats = getAllChats(username);
  const id = genId();
  chats[id] = {
    id,
    title: "Neuer Chat",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveAllChats(username, chats);
  return id;
}

function getChat(username, chatId) {
  const chats = getAllChats(username);
  return chats[chatId] || null;
}

function saveChat(username, chatId, chat) {
  const chats = getAllChats(username);
  chats[chatId] = { ...chat, updatedAt: Date.now() };
  saveAllChats(username, chats);
}

function deleteChat(username, chatId) {
  const chats = getAllChats(username);
  delete chats[chatId];
  saveAllChats(username, chats);
}

function getSortedChats(username) {
  const chats = getAllChats(username);
  return Object.values(chats).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MARKDOWN RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function configureMarkdown() {
  if (typeof marked === "undefined") return;

  const renderer = new marked.Renderer();

  // Custom code block renderer with copy button
  renderer.code = function (code, language) {
    const lang = language && typeof language === "object" ? language.lang || "" : (language || "");
    const validLang = lang && hljs && hljs.getLanguage(lang) ? lang : "plaintext";
    let highlighted = "";
    try {
      if (typeof hljs !== "undefined") {
        highlighted = hljs.highlight(typeof code === "object" ? code.text || "" : code, {
          language: validLang,
          ignoreIllegals: true,
        }).value;
      } else {
        highlighted = escapeHtml(typeof code === "object" ? code.text || "" : code);
      }
    } catch {
      highlighted = escapeHtml(typeof code === "object" ? code.text || "" : code);
    }
    const codeText = typeof code === "object" ? code.text || "" : code;
    const escapedCode = encodeURIComponent(codeText);
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${escapeHtml(validLang)}</span><button class="copy-code-btn" type="button" data-code="${escapedCode}" aria-label="Code kopieren"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Kopieren</span></button></div><pre><code class="hljs language-${escapeHtml(validLang)}">${highlighted}</code></pre></div>`;
  };

  marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
  });
}

function renderMarkdown(raw) {
  if (typeof marked === "undefined") {
    return `<p>${escapeHtml(raw)}</p>`;
  }
  try {
    const html = marked.parse(raw);
    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [
          "p","br","strong","em","u","s","code","pre","blockquote",
          "ul","ol","li","h1","h2","h3","h4","h5","h6",
          "a","table","thead","tbody","tr","th","td",
          "div","span","button","svg","path","rect","polyline","line","circle","polygon",
        ],
        ALLOWED_ATTR: [
          "href","target","rel","class","id","type","data-code",
          "aria-label","width","height","viewBox","fill","stroke","stroke-width",
          "d","x","y","x1","y1","x2","y2","cx","cy","r","rx","ry","points",
        ],
        ADD_ATTR: ["target"],
      });
    }
    return html;
  } catch {
    return `<p>${escapeHtml(raw)}</p>`;
  }
}

// Handle copy-code button clicks via event delegation
function handleCopyCodeClick(event) {
  const btn = event.target.closest(".copy-code-btn");
  if (!btn) return;
  event.stopPropagation();
  const encodedCode = btn.dataset.code || "";
  const code = decodeURIComponent(encodedCode);
  const labelSpan = btn.querySelector("span");
  navigator.clipboard.writeText(code).then(() => {
    if (labelSpan) {
      const orig = labelSpan.textContent;
      labelSpan.textContent = "Kopiert!";
      btn.classList.add("copied");
      setTimeout(() => {
        labelSpan.textContent = orig;
        btn.classList.remove("copied");
      }, 2000);
    }
  }).catch(() => {
    showToast("Kopieren fehlgeschlagen.", "error");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SAFETY FILTER
// ═══════════════════════════════════════════════════════════════════════════════

function isUnsafeInput(text) {
  return SAFETY_PATTERNS.some(pattern => pattern.test(text));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBLLM ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

async function initWebLLM() {
  try {
    updateModelStatus("loading", "WebLLM wird geladen…");

    // Dynamic import of WebLLM from CDN
    try {
      webllmModule = await import("https://esm.run/@mlc-ai/web-llm@0.2.73");
    } catch (importErr) {
      console.error("Primary CDN failed, trying fallback:", importErr);
      try {
        webllmModule = await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.73/+esm");
      } catch (fallbackErr) {
        throw new Error("WebLLM konnte nicht geladen werden. Bitte überprüfe deine Internetverbindung.");
      }
    }

    // Check WebGPU availability
    const hasWebGPU = navigator.gpu !== undefined;
    if (!hasWebGPU) {
      showWebGPUWarning();
      return;
    }

    updateModelStatus("loading", `Lade Modell: ${MODEL_ID}…`);

    // Create the engine
    engine = await webllmModule.CreateMLCEngine(
      MODEL_ID,
      {
        initProgressCallback: (progress) => {
          const pct = Math.round((progress.progress || 0) * 100);
          updateLoadingProgress(pct, progress.text || `Lade Modell… ${pct}%`);
        },
      }
    );

    engineReady = true;
    hideLoadingBanner();
    updateModelStatus("ready", "Modell bereit");
    showToast("MoonAi ist bereit!", "success");

  } catch (err) {
    console.error("WebLLM init error:", err);
    engineReady = false;
    hideLoadingBanner();
    updateModelStatus("error", "Modell-Fehler");
    showEngineError(err.message || "Ein unbekannter Fehler ist beim Laden des Modells aufgetreten.");
  }
}

function updateLoadingProgress(pct, detail) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  elLoadingProgressBar.style.width = `${clampedPct}%`;
  elLoadingProgressTxt.textContent = `${clampedPct}%`;
  elLoadingProgressbox.setAttribute("aria-valuenow", clampedPct);
  if (detail) {
    elLoadingDetail.textContent = detail;
  }
}

function hideLoadingBanner() {
  elModelLoadingBanner.classList.add("hidden");
  setTimeout(() => {
    elModelLoadingBanner.style.display = "none";
  }, 400);
}

function updateModelStatus(state, text) {
  elStatusText.textContent = text;
  elStatusDot.className = `status-dot status-${state}`;
}

function showWebGPUWarning() {
  hideLoadingBanner();
  updateModelStatus("error", "WebGPU nicht verfügbar");
  appendSystemMessage(
    "⚠️ **WebGPU wird von deinem Browser nicht unterstützt.**\n\n" +
    "MoonAi benötigt WebGPU, um das KI-Modell direkt in deinem Browser auszuführen. " +
    "Bitte versuche es mit Google Chrome 113+, Microsoft Edge 113+ oder Opera. " +
    "Firefox und Safari unterstützen WebGPU derzeit noch eingeschränkt.\n\n" +
    "Stelle außerdem sicher, dass die Hardwarebeschleunigung in deinen Browsereinstellungen aktiviert ist.",
    "warning"
  );
}

function showEngineError(msg) {
  appendSystemMessage(
    `⚠️ **KI-Modell konnte nicht geladen werden.**\n\n${msg}\n\n` +
    "Mögliche Lösungen:\n" +
    "- Aktualisiere deinen Browser auf die neueste Version.\n" +
    "- Stelle sicher, dass WebGPU und Hardwarebeschleunigung aktiviert sind.\n" +
    "- Schließe andere Tabs und Apps, um Arbeitsspeicher freizugeben.\n" +
    "- Lade die Seite neu und versuche es erneut.",
    "error"
  );
}

async function generateResponse(messages, onChunk, signal) {
  if (!engine || !engineReady) {
    throw new Error("Das KI-Modell ist noch nicht bereit. Bitte warte einen Moment.");
  }

  // Build messages array for the engine (max context window)
  const contextMessages = buildContextMessages(messages);

  const stream = await engine.chat.completions.create({
    messages: contextMessages,
    stream: true,
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 1024,
  });

  let fullText = "";
  for await (const chunk of stream) {
    if (signal && signal.aborted) {
      break;
    }
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) {
      fullText += delta;
      onChunk(fullText);
    }
  }
  return fullText;
}

function buildContextMessages(messages) {
  // System prompt
  const systemMsg = {
    role: "system",
    content:
      "Du bist MoonAi, ein hilfreicher, freundlicher und intelligenter KI-Assistent. " +
      "Du antwortest auf Deutsch, sofern der Nutzer nicht explizit eine andere Sprache verwendet. " +
      "Du bist präzise, respektvoll und gibst ehrliche, fundierte Antworten. " +
      "Du weigerst dich höflich, Anfragen zu bearbeiten, die schädlich, illegal oder unethisch sind.",
  };

  // Take the last MAX_CONTEXT_MSGS messages to stay within context window
  const recentMessages = messages.slice(-MAX_CONTEXT_MSGS);

  // Convert our message format to WebLLM format
  const formatted = recentMessages.map(m => {
    if (m.role === "user" && m.image) {
      // For multimodal: include image description
      return {
        role: "user",
        content: `[Bild angehängt]\n${m.content}`,
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });

  return [systemMsg, ...formatted];
}

async function generateChatTitle(firstUserMessage) {
  if (!engine || !engineReady) {
    return firstUserMessage.slice(0, 30) + (firstUserMessage.length > 30 ? "…" : "");
  }

  try {
    const resp = await engine.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Erstelle einen kurzen Titel (3-4 Wörter, kein Punkt am Ende) für folgende Nutzeranfrage. Antworte NUR mit dem Titel, ohne Anführungszeichen.",
        },
        {
          role: "user",
          content: firstUserMessage.slice(0, 200),
        },
      ],
      max_tokens: 20,
      temperature: 0.5,
    });
    const title = resp.choices?.[0]?.message?.content?.trim() || firstUserMessage.slice(0, 30);
    return title.length > 50 ? title.slice(0, 47) + "…" : title;
  } catch {
    return firstUserMessage.slice(0, 30) + (firstUserMessage.length > 30 ? "…" : "");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI – CHAT RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function appendSystemMessage(markdownText, type = "info") {
  hideWelcomeScreen();
  const el = document.createElement("div");
  el.className = `system-message system-message-${type}`;
  el.setAttribute("role", "note");
  el.innerHTML = renderMarkdown(markdownText);
  elChatMessages.appendChild(el);
  scrollToBottom();
  attachCopyHandlers(el);
}

function appendUserMessage(text, imageB64, imageMime) {
  hideWelcomeScreen();
  const el = document.createElement("div");
  el.className = "message message-user";
  el.setAttribute("role", "article");
  el.setAttribute("aria-label", "Deine Nachricht");

  let imgHtml = "";
  if (imageB64 && imageMime) {
    imgHtml = `<div class="message-image-wrap"><img class="message-image" src="data:${imageMime};base64,${imageB64}" alt="Hochgeladenes Bild" /></div>`;
  }

  const textHtml = text ? `<div class="message-bubble">${renderMarkdown(text)}</div>` : "";

  el.innerHTML = `${imgHtml}${textHtml}`;
  elChatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

function appendAIMessage() {
  hideWelcomeScreen();
  const el = document.createElement("div");
  el.className = "message message-ai";
  el.setAttribute("role", "article");
  el.setAttribute("aria-label", "MoonAi Antwort");

  const iconHtml = `
    <div class="ai-avatar" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="45" fill="#007AFF"/>
        <path d="M35 30 Q50 20 65 30 Q75 50 65 70 Q50 80 35 70 Q25 50 35 30Z" fill="#0051D4" opacity="0.8"/>
      </svg>
    </div>`;

  const bubbleHtml = `<div class="message-bubble ai-bubble"><span class="cursor-blink" aria-hidden="true">▋</span></div>`;

  el.innerHTML = `${iconHtml}${bubbleHtml}`;
  elChatMessages.appendChild(el);
  scrollToBottom();

  return el.querySelector(".message-bubble");
}

function updateAIBubble(bubbleEl, fullText, isStreaming) {
  const rendered = renderMarkdown(fullText);
  if (isStreaming) {
    bubbleEl.innerHTML = rendered + `<span class="cursor-blink" aria-hidden="true">▋</span>`;
  } else {
    bubbleEl.innerHTML = rendered;
  }
  attachCopyHandlers(bubbleEl);
  scrollToBottom();
}

function hideWelcomeScreen() {
  if (elWelcomeScreen && !elWelcomeScreen.hidden) {
    elWelcomeScreen.setAttribute("aria-hidden", "true");
    elWelcomeScreen.classList.add("hidden");
    setTimeout(() => {
      elWelcomeScreen.hidden = true;
    }, 300);
  }
}

function showWelcomeScreen() {
  if (elWelcomeScreen) {
    elWelcomeScreen.hidden = false;
    elWelcomeScreen.removeAttribute("aria-hidden");
    elWelcomeScreen.classList.remove("hidden");
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    elChatMessages.scrollTop = elChatMessages.scrollHeight;
  });
}

function attachCopyHandlers(container) {
  container.querySelectorAll(".copy-code-btn").forEach(btn => {
    // Remove existing listener to avoid duplicates
    btn.replaceWith(btn.cloneNode(true));
  });
  container.addEventListener("click", handleCopyCodeClick, { capture: true });
}

function renderChatHistory() {
  if (!currentUser) return;
  const chats = getSortedChats(currentUser);
  elChatHistoryList.innerHTML = "";

  if (chats.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Noch keine Chats.";
    empty.setAttribute("role", "listitem");
    elChatHistoryList.appendChild(empty);
    return;
  }

  chats.forEach(chat => {
    const item = document.createElement("div");
    item.className = "history-item" + (chat.id === currentChatId ? " active" : "");
    item.setAttribute("role", "listitem");
    item.dataset.chatId = chat.id;

    const titleSpan = document.createElement("span");
    titleSpan.className = "history-title";
    titleSpan.textContent = chat.title;
    titleSpan.title = chat.title;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-delete-btn";
    deleteBtn.setAttribute("aria-label", `Chat "${chat.title}" löschen`);
    deleteBtn.type = "button";
    deleteBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteChat(chat.id);
    });

    item.appendChild(titleSpan);
    item.appendChild(deleteBtn);

    item.addEventListener("click", () => {
      loadChat(chat.id);
      closeSidebarOnMobile();
    });

    elChatHistoryList.appendChild(item);
  });
}

function handleDeleteChat(chatId) {
  if (!currentUser) return;
  if (!confirm("Diesen Chat wirklich löschen?")) return;
  deleteChat(currentUser, chatId);
  if (currentChatId === chatId) {
    startNewChat();
  } else {
    renderChatHistory();
  }
  showToast("Chat gelöscht.", "info");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function startNewChat() {
  if (!currentUser) return;
  currentChatId = createNewChat(currentUser);
  elChatMessages.innerHTML = "";
  showWelcomeScreen();
  elChatMessages.appendChild(elWelcomeScreen);
  elTopbarTitle.textContent = "MoonAi";
  clearImagePreview();
  elChatInput.value = "";
  updateSendButton();
  renderChatHistory();
}

function loadChat(chatId) {
  if (!currentUser) return;
  const chat = getChat(currentUser, chatId);
  if (!chat) {
    showToast("Chat nicht gefunden.", "error");
    return;
  }

  currentChatId = chatId;
  elChatMessages.innerHTML = "";

  if (chat.messages.length === 0) {
    showWelcomeScreen();
    elChatMessages.appendChild(elWelcomeScreen);
  } else {
    chat.messages.forEach(msg => {
      if (msg.role === "user") {
        appendUserMessage(msg.content, msg.image || null, msg.imageMime || null);
      } else if (msg.role === "assistant") {
        const bubble = appendAIMessage();
        updateAIBubble(bubble, msg.content, false);
      }
    });
  }

  elTopbarTitle.textContent = chat.title || "MoonAi";
  clearImagePreview();
  renderChatHistory();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IMAGE UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

function handleImageUpload(file) {
  if (!file) return;

  const allowedTypes = ["image/jpeg", "image/jpg", "image/png"];
  if (!allowedTypes.includes(file.type)) {
    showToast("Bitte nur JPG oder PNG-Dateien hochladen.", "warning");
    elFileImageUpload.value = "";
    return;
  }

  if (file.size > MAX_IMG_BYTES) {
    showToast("Das Bild ist zu groß. Maximum: 5 MB.", "warning");
    elFileImageUpload.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    // Extract base64 part
    const base64 = dataUrl.split(",")[1];
    if (!base64) {
      showToast("Bild konnte nicht gelesen werden.", "error");
      return;
    }
    pendingImageB64   = base64;
    pendingImageType  = file.type;

    elImagePreviewThumb.src = dataUrl;
    elImagePreviewThumb.alt = `Vorschau: ${file.name}`;
    elImagePreviewName.textContent = file.name.length > 30
      ? file.name.slice(0, 27) + "…"
      : file.name;

    elImagePreviewArea.removeAttribute("hidden");
    updateSendButton();
    elChatInput.focus();
  };
  reader.onerror = () => {
    showToast("Fehler beim Lesen des Bildes.", "error");
    elFileImageUpload.value = "";
  };
  reader.readAsDataURL(file);
}

function clearImagePreview() {
  pendingImageB64  = null;
  pendingImageType = null;
  elImagePreviewThumb.src = "";
  elImagePreviewArea.setAttribute("hidden", "");
  elFileImageUpload.value = "";
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SEND MESSAGE FLOW
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSendMessage() {
  if (isGenerating) {
    // Stop generation
    if (abortController) {
      abortController.abort();
    }
    return;
  }

  if (!currentUser || !currentChatId) return;

  // Rate limit check
  const rateResult = checkRateLimit(currentUser);
  if (!rateResult.allowed) {
    updateRateLimitUI(currentUser);
    return;
  }

  const text = elChatInput.value.trim();
  const hasImage = !!pendingImageB64;

  if (!text && !hasImage) return;
  if (!engineReady) {
    showToast("Das KI-Modell ist noch nicht geladen. Bitte warte einen Moment.", "warning");
    return;
  }

  // Safety filter
  if (text && isUnsafeInput(text)) {
    appendUserMessage(text, null, null);
    const aiBubble = appendAIMessage();
    updateAIBubble(aiBubble, SAFETY_RESPONSE, false);

    // Save to chat
    const chat = getChat(currentUser, currentChatId);
    if (chat) {
      chat.messages.push({ role: "user", content: text });
      chat.messages.push({ role: "assistant", content: SAFETY_RESPONSE });
      saveChat(currentUser, currentChatId, chat);
    }
    recordMessage(currentUser);
    updateRateLimitUI(currentUser);
    elChatInput.value = "";
    autoResizeTextarea();
    updateSendButton();
    return;
  }

  // Capture image before clearing
  const imageB64  = pendingImageB64;
  const imageMime = pendingImageType;

  // Clear input & image
  const userText = text;
  elChatInput.value = "";
  autoResizeTextarea();
  clearImagePreview();
  updateSendButton();

  // Append user message to UI
  appendUserMessage(userText, imageB64, imageMime);

  // Get or create chat
  let chat = getChat(currentUser, currentChatId);
  if (!chat) return;

  // Build user message for storage (without raw base64 image to save space, use a flag)
  const userMsg = {
    role: "user",
    content: userText,
    ...(imageB64 ? { image: imageB64, imageMime } : {}),
    timestamp: Date.now(),
  };
  chat.messages.push(userMsg);

  // Generate title from first message
  if (chat.messages.filter(m => m.role === "user").length === 1) {
    const titleText = userText || "Bildanalyse";
    generateChatTitle(titleText).then(title => {
      if (chat) {
        chat.title = title;
        saveChat(currentUser, currentChatId, chat);
        elTopbarTitle.textContent = title;
        renderChatHistory();
      }
    });
  }

  // Record rate limit
  recordMessage(currentUser);
  updateRateLimitUI(currentUser);

  // Start AI generation
  isGenerating = true;
  abortController = new AbortController();
  setSendButtonGenerating(true);

  const aiBubble = appendAIMessage();

  try {
    // Build messages for the engine (includes history for context)
    const engineMessages = chat.messages.map(m => ({
      role: m.role,
      content: m.role === "user" && m.image
        ? `[Bildbeschreibung angefordert]\n${m.content || "Was ist auf diesem Bild zu sehen?"}`
        : m.content,
    }));

    let fullResponse = "";
    fullResponse = await generateResponse(
      engineMessages,
      (partial) => {
        updateAIBubble(aiBubble, partial, true);
      },
      abortController.signal
    );

    if (abortController.signal.aborted) {
      fullResponse = fullResponse || "[Generierung gestoppt]";
    }

    // Finalize bubble
    updateAIBubble(aiBubble, fullResponse, false);

    // Save AI response
    chat = getChat(currentUser, currentChatId);
    if (chat) {
      chat.messages.push({
        role: "assistant",
        content: fullResponse,
        timestamp: Date.now(),
      });
      saveChat(currentUser, currentChatId, chat);
    }

  } catch (err) {
    console.error("Generation error:", err);
    const errorMsg = err.name === "AbortError"
      ? "[Generierung gestoppt]"
      : `Fehler: ${err.message || "Unbekannter Fehler"}`;
    updateAIBubble(aiBubble, errorMsg, false);

    if (err.name !== "AbortError") {
      showToast("Fehler bei der KI-Antwort.", "error");
    }
  } finally {
    isGenerating = false;
    abortController = null;
    setSendButtonGenerating(false);
    renderChatHistory();
    updateRateLimitUI(currentUser);
  }
}

function setSendButtonGenerating(generating) {
  if (generating) {
    elBtnSend.setAttribute("aria-label", "Generierung stoppen");
    elBtnSend.title = "Stoppen";
    elBtnSend.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
    elBtnSend.disabled = false;
    elBtnSend.classList.add("generating");
  } else {
    elBtnSend.setAttribute("aria-label", "Nachricht senden");
    elBtnSend.title = "Senden";
    elBtnSend.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    elBtnSend.classList.remove("generating");
    updateSendButton();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI – AUTH FLOW
// ═══════════════════════════════════════════════════════════════════════════════

function showApp(username) {
  currentUser = username;
  elAuthOverlay.hidden = true;
  elAuthOverlay.setAttribute("aria-hidden", "true");
  elApp.hidden = false;
  elApp.removeAttribute("aria-hidden");
  elSidebarUserInfo.textContent = `👤 ${username}`;

  // Init first chat
  const chats = getSortedChats(username);
  if (chats.length > 0) {
    loadChat(chats[0].id);
  } else {
    currentChatId = createNewChat(username);
    renderChatHistory();
  }

  updateRateLimitUI(username);
  elChatInput.focus();
}

function showAuthScreen() {
  currentUser = null;
  currentChatId = null;
  elApp.hidden = true;
  elApp.setAttribute("aria-hidden", "true");
  elAuthOverlay.hidden = false;
  elAuthOverlay.removeAttribute("aria-hidden");
  elLoginUsername.focus();
}

function logout() {
  if (isGenerating && abortController) {
    abortController.abort();
  }
  clearSession();
  currentUser = null;
  currentChatId = null;
  isGenerating = false;
  pendingImageB64 = null;
  pendingImageType = null;
  showAuthScreen();
  showToast("Du wurdest abgemeldet.", "info");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI – SIDEBAR
// ═══════════════════════════════════════════════════════════════════════════════

function openSidebar() {
  elSidebar.classList.add("open");
  elSidebarOverlay.classList.add("visible");
  elSidebarOverlay.removeAttribute("aria-hidden");
  elBtnOpenSidebar.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
}

function closeSidebar() {
  elSidebar.classList.remove("open");
  elSidebarOverlay.classList.remove("visible");
  elSidebarOverlay.setAttribute("aria-hidden", "true");
  elBtnOpenSidebar.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function closeSidebarOnMobile() {
  if (window.innerWidth < 768) {
    closeSidebar();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI – TEXTAREA AUTO-RESIZE
// ═══════════════════════════════════════════════════════════════════════════════

function autoResizeTextarea() {
  elChatInput.style.height = "auto";
  const scrollH = elChatInput.scrollHeight;
  const maxH = 200;
  elChatInput.style.height = Math.min(scrollH, maxH) + "px";
  elChatInput.style.overflowY = scrollH > maxH ? "auto" : "hidden";
}

function updateSendButton() {
  const hasContent = elChatInput.value.trim().length > 0 || !!pendingImageB64;
  elBtnSend.disabled = !hasContent || !engineReady;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════════

function bindAuthEvents() {
  // Tab switching
  elTabLogin.addEventListener("click", () => {
    elTabLogin.classList.add("active");
    elTabLogin.setAttribute("aria-selected", "true");
    elTabRegister.classList.remove("active");
    elTabRegister.setAttribute("aria-selected", "false");
    elPanelLogin.classList.add("active");
    elPanelLogin.removeAttribute("hidden");
    elPanelRegister.classList.remove("active");
    elPanelRegister.setAttribute("hidden", "");
    clearAuthError(elLoginError);
    elLoginUsername.focus();
  });

  elTabRegister.addEventListener("click", () => {
    elTabRegister.classList.add("active");
    elTabRegister.setAttribute("aria-selected", "true");
    elTabLogin.classList.remove("active");
    elTabLogin.setAttribute("aria-selected", "false");
    elPanelRegister.classList.add("active");
    elPanelRegister.removeAttribute("hidden");
    elPanelLogin.classList.remove("active");
    elPanelLogin.setAttribute("hidden", "");
    clearAuthError(elRegError);
    elRegUsername.focus();
  });

  // Login
  elBtnLogin.addEventListener("click", async () => {
    clearAuthError(elLoginError);
    const username = elLoginUsername.value.trim();
    const password = elLoginPassword.value;

    if (!username || !password) {
      showAuthError(elLoginError, "Bitte alle Felder ausfüllen.");
      return;
    }

    setButtonLoading(elBtnLogin, true);
    try {
      const displayName = await loginUser(username, password);
      saveSession(displayName);
      elLoginPassword.value = "";
      showApp(displayName);
    } catch (err) {
      showAuthError(elLoginError, err.message);
    } finally {
      setButtonLoading(elBtnLogin, false);
    }
  });

  // Enter key on login fields
  [elLoginUsername, elLoginPassword].forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        elBtnLogin.click();
      }
    });
  });

  // Register
  elBtnRegister.addEventListener("click", async () => {
    clearAuthError(elRegError);
    const username = elRegUsername.value.trim();
    const password = elRegPassword.value;
    const confirm  = elRegConfirm.value;

    if (!username || !password || !confirm) {
      showAuthError(elRegError, "Bitte alle Felder ausfüllen.");
      return;
    }
    if (password !== confirm) {
      showAuthError(elRegError, "Passwörter stimmen nicht überein.");
      return;
    }

    setButtonLoading(elBtnRegister, true);
    try {
      await registerUser(username, password);
      const displayName = await loginUser(username, password);
      saveSession(displayName);
      elRegPassword.value = "";
      elRegConfirm.value = "";
      showApp(displayName);
      showToast("Konto erstellt! Willkommen bei MoonAi.", "success");
    } catch (err) {
      showAuthError(elRegError, err.message);
    } finally {
      setButtonLoading(elBtnRegister, false);
    }
  });

  // Enter key on register fields
  [elRegUsername, elRegPassword, elRegConfirm].forEach(el => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        elBtnRegister.click();
      }
    });
  });

  // Toggle password visibility
  document.querySelectorAll(".toggle-password").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      btn.setAttribute("aria-label", isHidden ? "Passwort verbergen" : "Passwort anzeigen");
    });

    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        btn.click();
      }
    });
  });
}

function bindAppEvents() {
  // Sidebar toggle
  elBtnOpenSidebar.addEventListener("click", openSidebar);
  elBtnCloseSidebar.addEventListener("click", closeSidebar);
  elSidebarOverlay.addEventListener("click", closeSidebar);

  // New chat
  elBtnNewChat.addEventListener("click", () => {
    startNewChat();
    closeSidebarOnMobile();
    elChatInput.focus();
  });

  // Logout
  elBtnLogout.addEventListener("click", () => {
    if (confirm("Wirklich abmelden?")) {
      logout();
    }
  });

  // Image upload via label (keyboard accessible)
  elLabelImageUpload.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      elFileImageUpload.click();
    }
  });

  // Image file input change
  elFileImageUpload.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleImageUpload(file);
  });

  // Remove image
  elBtnRemoveImage.addEventListener("click", () => {
    clearImagePreview();
    updateSendButton();
    elChatInput.focus();
  });

  // Chat input – auto-resize and send button state
  elChatInput.addEventListener("input", () => {
    autoResizeTextarea();
    updateSendButton();
  });

  // Send on Enter (Shift+Enter = newline)
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!elBtnSend.disabled || isGenerating) {
        handleSendMessage();
      }
    }
  });

  // Send button
  elBtnSend.addEventListener("click", handleSendMessage);

  // Drag and drop image onto chat
  elChatMessages.addEventListener("dragover", (e) => {
    e.preventDefault();
    elChatMessages.classList.add("drag-over");
  });
  elChatMessages.addEventListener("dragleave", (e) => {
    if (!elChatMessages.contains(e.relatedTarget)) {
      elChatMessages.classList.remove("drag-over");
    }
  });
  elChatMessages.addEventListener("drop", (e) => {
    e.preventDefault();
    elChatMessages.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleImageUpload(file);
  });

  // Keyboard shortcut: Escape closes sidebar on mobile
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (elSidebar.classList.contains("open")) {
        closeSidebar();
      }
    }
  });

  // Paste image from clipboard
  document.addEventListener("paste", (e) => {
    if (elApp.hidden) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          handleImageUpload(file);
          break;
        }
      }
    }
  });

  // Resize handler – close overlay if window becomes desktop-width
  window.addEventListener("resize", debounce(() => {
    if (window.innerWidth >= 768 && elSidebarOverlay.classList.contains("visible")) {
      elSidebarOverlay.classList.remove("visible");
      document.body.style.overflow = "";
    }
  }, 150));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  // Configure markdown rendering
  // We need to wait for scripts to load
  await waitForScripts();
  configureMarkdown();

  // Bind all auth & app events
  bindAuthEvents();
  bindAppEvents();

  // Check existing session
  const session = getSession();
  if (session && session.username) {
    const users = getUsers();
    const key = session.username.toLowerCase();
    if (users[key]) {
      showApp(session.username);
    } else {
      clearSession();
      showAuthScreen();
    }
  } else {
    showAuthScreen();
  }

  // Start loading WebLLM (non-blocking – runs in background)
  initWebLLM();
}

function waitForScripts(maxWaitMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const ready =
        typeof marked !== "undefined" &&
        typeof DOMPurify !== "undefined";

      if (ready || Date.now() - start > maxWaitMs) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Wait for DOM to be fully ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
