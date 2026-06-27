/* ============================================================
   script.js – MoonAi Frontend Logic
   ============================================================ */
"use strict";

// ─── Marked.js konfigurieren ──────────────────────────────────
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; }
      catch {}
    }
    return hljs.highlightAuto(code).value;
  },
});

// Code-Block-Renderer mit Kopieren-Button
const renderer = new marked.Renderer();
renderer.code = function (code, lang) {
  const language = lang || "text";
  let highlighted = code;
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {}
  return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${escapeHtml(language)}</span>
        <button class="copy-btn" onclick="copyCode(this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          Kopieren
        </button>
      </div>
      <pre><code>${highlighted}</code></pre>
    </div>`;
};
marked.use({ renderer });

// ─── State ────────────────────────────────────────────────────
let token = localStorage.getItem("moonai_token") || null;
let username = localStorage.getItem("moonai_username") || null;
let currentChatId = null;
let isStreaming = false;
let selectedFile = null;

// ─── DOM-Referenzen ───────────────────────────────────────────
const authOverlay    = document.getElementById("auth-overlay");
const app            = document.getElementById("app");
const sidebar        = document.getElementById("sidebar");
const sidebarToggle  = document.getElementById("sidebar-toggle");
const chatList       = document.getElementById("chat-list");
const newChatBtn     = document.getElementById("new-chat-btn");
const messagesEl     = document.getElementById("messages");
const emptyState     = document.getElementById("empty-state");
const messageInput   = document.getElementById("message-input");
const sendBtn        = document.getElementById("send-btn");
const fileInput      = document.getElementById("file-input");
const uploadBtn      = document.getElementById("upload-btn");
const imagePreview   = document.getElementById("image-preview");
const imgPreviewCont = document.getElementById("image-preview-container");
const removeImgBtn   = document.getElementById("remove-image-btn");
const userNameDisp   = document.getElementById("user-name-display");
const userAvatar     = document.getElementById("user-avatar");
const logoutBtn      = document.getElementById("logout-btn");

// ─── Auth Tabs ────────────────────────────────────────────────
document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab, .auth-form").forEach(el => el.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// Login
document.getElementById("login-btn").addEventListener("click", async () => {
  const identifier = document.getElementById("login-identifier").value.trim();
  const password   = document.getElementById("login-password").value;
  const errEl      = document.getElementById("login-error");
  clearError(errEl);

  if (!identifier || !password) return showError(errEl, "Bitte alle Felder ausfüllen.");

  const btn = document.getElementById("login-btn");
  btn.disabled = true; btn.textContent = "Anmelden …";
  try {
    const res  = await apiFetch("/api/auth/login", "POST", { identifier, password }, false);
    const data = await res.json();
    if (!res.ok) return showError(errEl, data.error);
    setAuth(data.token, data.username);
    initApp();
  } catch { showError(errEl, "Netzwerkfehler."); }
  finally { btn.disabled = false; btn.textContent = "Anmelden"; }
});
document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

// Registrieren
document.getElementById("register-btn").addEventListener("click", async () => {
  const uname    = document.getElementById("reg-username").value.trim();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const errEl    = document.getElementById("reg-error");
  const succEl   = document.getElementById("reg-success");
  clearError(errEl); succEl.classList.add("hidden");

  if (!uname || !email || !password) return showError(errEl, "Bitte alle Felder ausfüllen.");

  const btn = document.getElementById("register-btn");
  btn.disabled = true; btn.textContent = "Konto erstellen …";
  try {
    const res  = await apiFetch("/api/auth/register", "POST", { username: uname, email, password }, false);
    const data = await res.json();
    if (!res.ok) return showError(errEl, data.error);
    succEl.textContent = "Konto erstellt! Jetzt anmelden.";
    succEl.classList.remove("hidden");
    setTimeout(() => {
      document.querySelector('[data-tab="login"]').click();
      document.getElementById("login-identifier").value = uname;
    }, 1200);
  } catch { showError(errEl, "Netzwerkfehler."); }
  finally { btn.disabled = false; btn.textContent = "Konto erstellen"; }
});

// ─── App initialisieren ───────────────────────────────────────
async function initApp() {
  if (!token) { showAuth(); return; }
  hideAuth();
  userNameDisp.textContent = username;
  userAvatar.textContent = (username || "?")[0].toUpperCase();
  await loadChats();
}

function showAuth() {
  authOverlay.classList.remove("hidden");
  app.classList.add("hidden");
}

function hideAuth() {
  authOverlay.classList.add("hidden");
  app.classList.remove("hidden");
}

function setAuth(t, u) {
  token = t; username = u;
  localStorage.setItem("moonai_token", t);
  localStorage.setItem("moonai_username", u);
}

function clearAuth() {
  token = null; username = null; currentChatId = null;
  localStorage.removeItem("moonai_token");
  localStorage.removeItem("moonai_username");
}

// Logout
logoutBtn.addEventListener("click", () => {
  clearAuth();
  showAuth();
  chatList.innerHTML = "";
  messagesEl.innerHTML = "";
  messagesEl.classList.add("hidden");
  emptyState.classList.remove("hidden");
});

// ─── Sidebar Toggle ───────────────────────────────────────────
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});

// ─── Chat-Liste laden ─────────────────────────────────────────
async function loadChats() {
  try {
    const res   = await apiFetch("/api/chats", "GET");
    if (!res.ok) { if (res.status === 401) { clearAuth(); showAuth(); } return; }
    const chats = await res.json();
    renderChatList(chats);
  } catch { showToast("Chats konnten nicht geladen werden.", "error"); }
}

function renderChatList(chats) {
  chatList.innerHTML = "";
  chats.forEach(chat => {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === currentChatId ? " active" : ""}`;
    item.dataset.id = chat.id;
    item.innerHTML = `
      <span class="chat-item-title">${escapeHtml(chat.title)}</span>
      <button class="chat-delete-btn" title="Chat löschen" data-id="${chat.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
        </svg>
      </button>`;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".chat-delete-btn")) return;
      openChat(chat.id);
    });
    item.querySelector(".chat-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat.id, item);
    });
    chatList.appendChild(item);
  });
}

// ─── Neuer Chat ───────────────────────────────────────────────
newChatBtn.addEventListener("click", async () => {
  try {
    const res  = await apiFetch("/api/chats", "POST");
    const data = await res.json();
    if (!res.ok) return showToast(data.error, "error");
    currentChatId = data.id;
    await loadChats();
    openChat(data.id, true);
  } catch { showToast("Fehler beim Erstellen.", "error"); }
});

// ─── Chat öffnen ──────────────────────────────────────────────
async function openChat(chatId, empty = false) {
  currentChatId = chatId;
  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.id) === chatId);
  });
  messagesEl.innerHTML = "";
  if (empty) {
    showEmpty();
    return;
  }
  try {
    const res = await apiFetch(`/api/chats/${chatId}/messages`, "GET");
    if (!res.ok) return;
    const msgs = await res.json();
    if (msgs.length === 0) { showEmpty(); return; }
    hideEmpty();
    msgs.forEach(msg => renderMessage(msg.role, msg.content, msg.image_path));
    scrollToBottom();
  } catch { showToast("Nachrichten konnten nicht geladen werden.", "error"); }
}

function showEmpty() {
  emptyState.classList.remove("hidden");
  messagesEl.classList.add("hidden");
}
function hideEmpty() {
  emptyState.classList.add("hidden");
  messagesEl.classList.remove("hidden");
}

// ─── Chat löschen ─────────────────────────────────────────────
async function deleteChat(chatId, itemEl) {
  itemEl.style.opacity = "0.4";
  try {
    const res = await apiFetch(`/api/chats/${chatId}`, "DELETE");
    if (!res.ok) { itemEl.style.opacity = "1"; return; }
    if (currentChatId === chatId) {
      currentChatId = null;
      showEmpty();
    }
    itemEl.remove();
  } catch { itemEl.style.opacity = "1"; }
}

// ─── Nachricht rendern ────────────────────────────────────────
function renderMessage(role, content, imagePath = null) {
  const group = document.createElement("div");
  group.className = "message-group";

  if (role === "user") {
    if (imagePath) {
      const img = document.createElement("img");
      img.className = "user-image-preview";
      img.src = `/uploads/${imagePath}?t=${token}`;
      img.alt = "Hochgeladenes Bild";
      group.appendChild(img);
    }
    const bubble = document.createElement("div");
    bubble.className = "user-message";
    bubble.innerHTML = `<div class="user-bubble">${escapeHtml(content)}</div>`;
    group.appendChild(bubble);
  } else {
    group.innerHTML = `
      <div class="assistant-message">
        <div class="assistant-avatar">
          <svg viewBox="0 0 60 60" fill="none">
            <circle cx="30" cy="30" r="30" fill="#1a1a2e"/>
            <path d="M43 31a14 14 0 01-18 13.3A14 14 0 0130 17a14 14 0 0113 14z" fill="#7c6af7"/>
            <circle cx="37" cy="24" r="3" fill="#a89cf5" opacity="0.7"/>
          </svg>
        </div>
        <div class="assistant-content">${renderMarkdown(content)}</div>
      </div>`;
  }
  messagesEl.appendChild(group);
  return group;
}

function renderMarkdown(text) {
  return marked.parse(text || "");
}

// ─── Nachricht senden ─────────────────────────────────────────
async function sendMessage() {
  if (isStreaming) return;
  const text = messageInput.value.trim();
  if (!text && !selectedFile) return;
  if (!currentChatId) {
    // Auto-neuen Chat erstellen
    try {
      const res  = await apiFetch("/api/chats", "POST");
      const data = await res.json();
      if (!res.ok) return showToast(data.error, "error");
      currentChatId = data.id;
      await loadChats();
    } catch { return showToast("Fehler.", "error"); }
  }

  const msgText = text;
  const file    = selectedFile;

  // UI zurücksetzen
  messageInput.value = "";
  autoResizeTextarea();
  updateSendBtn();
  clearImagePreview();

  // User-Nachricht sofort anzeigen
  hideEmpty();
  renderMessage("user", msgText, null);
  scrollToBottom();

  // KI-Platzhalter
  const group = document.createElement("div");
  group.className = "message-group";
  group.innerHTML = `
    <div class="assistant-message">
      <div class="assistant-avatar">
        <svg viewBox="0 0 60 60" fill="none">
          <circle cx="30" cy="30" r="30" fill="#1a1a2e"/>
          <path d="M43 31a14 14 0 01-18 13.3A14 14 0 0130 17a14 14 0 0113 14z" fill="#7c6af7"/>
          <circle cx="37" cy="24" r="3" fill="#a89cf5" opacity="0.7"/>
        </svg>
      </div>
      <div class="assistant-content" id="streaming-content">
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`;
  messagesEl.appendChild(group);
  scrollToBottom();

  const contentEl = group.querySelector("#streaming-content");
  isStreaming = true;
  sendBtn.disabled = true;
  let fullText = "";

  try {
    const formData = new FormData();
    formData.append("message", msgText);
    if (file) formData.append("image", file);

    const res = await fetch(`/api/chats/${currentChatId}/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      contentEl.textContent = data.error || "Fehler beim Senden.";
      if (res.status === 429) showToast("⏱ Nachrichtenlimit erreicht. Bitte warte etwas.", "error");
      if (res.status === 401) { clearAuth(); showAuth(); }
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";

    contentEl.innerHTML = "";
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    contentEl.appendChild(cursor);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.text) {
            fullText += payload.text;
            cursor.remove();
            contentEl.innerHTML = renderMarkdown(fullText);
            contentEl.appendChild(cursor);
            scrollToBottom();
          }
          if (payload.title && payload.chatId) {
            updateChatTitle(payload.chatId, payload.title);
          }
          if (payload.done) {
            cursor.remove();
            contentEl.innerHTML = renderMarkdown(fullText);
          }
        } catch {}
      }
    }
    // hljs nachträglich auf alle Code-Blöcke anwenden
    contentEl.querySelectorAll("pre code").forEach(block => hljs.highlightElement(block));
  } catch (err) {
    contentEl.textContent = "❌ Verbindungsfehler.";
  } finally {
    isStreaming = false;
    sendBtn.disabled = messageInput.value.trim() === "" && !selectedFile;
    scrollToBottom();
  }
}

function updateChatTitle(chatId, title) {
  const item = document.querySelector(`.chat-item[data-id="${chatId}"] .chat-item-title`);
  if (item) item.textContent = title;
}

// ─── Bild-Upload ──────────────────────────────────────────────
uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("Datei zu groß. Maximum: 5 MB.", "error");
    fileInput.value = "";
    return;
  }
  selectedFile = file;
  const url = URL.createObjectURL(file);
  imagePreview.src = url;
  imgPreviewCont.classList.remove("hidden");
  updateSendBtn();
  fileInput.value = "";
});

removeImgBtn.addEventListener("click", clearImagePreview);

function clearImagePreview() {
  selectedFile = null;
  imagePreview.src = "";
  imgPreviewCont.classList.add("hidden");
  updateSendBtn();
}

// ─── Textarea Auto-Resize ─────────────────────────────────────
messageInput.addEventListener("input", () => {
  autoResizeTextarea();
  updateSendBtn();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
}

function updateSendBtn() {
  const hasContent = messageInput.value.trim() !== "" || selectedFile !== null;
  sendBtn.disabled = !hasContent || isStreaming;
}

// ─── Hilfs-Funktionen ─────────────────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

function clearError(el) {
  el.textContent = "";
  el.classList.add("hidden");
}

function showToast(msg, type = "info") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function apiFetch(url, method = "GET", body = null, withAuth = true) {
  const headers = {};
  if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (withAuth && token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, {
    method,
    headers,
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : null,
  });
}

// Code kopieren (global, für onclick in gerenderten Blöcken)
window.copyCode = function (btn) {
  const code = btn.closest(".code-block-wrapper").querySelector("code").innerText;
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 12 4 8"/></svg> Kopiert!`;
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

// ─── Start ────────────────────────────────────────────────────
initApp();
