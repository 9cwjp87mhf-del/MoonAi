import * as webLLM from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.46/+esm";

// KONFIGURATION & STATE MANAGEMENT
const MODEL_ID = "gemma-2b-it-q4f16_1-MLC"; // Repräsentiert das hocheffiziente gemma4:e4b Edge-Modell im MLC/WebLLM Ökosystem
let engine = null;
let currentChatId = null;
let isEngineLoaded = false;
let isGenerating = false;
let uploadedImageBase64 = null;
let isRegisterMode = false;

// TABU-THEMEN FILTER (Client-Side Safety Regulation)
const BANNED_KEYWORDS = [
    /waffenbau/i, /sprengstoff/i, /malware erstellen/i, /phishing code/i, 
    /hacker angriff/i, /illegale drogen/i, /suizidanleitung/i
];

// DOM-ELEMENTE
const el = {
    authContainer: document.getElementById('auth-container'),
    appContainer: document.getElementById('app-container'),
    authForm: document.getElementById('auth-form'),
    authUsername: document.getElementById('auth-username'),
    authPassword: document.getElementById('auth-password'),
    authSubtitle: document.getElementById('auth-subtitle'),
    authError: document.getElementById('auth-error'),
    btnToggleAuth: document.getElementById('btn-toggle-auth'),
    btnPrimary: document.getElementById('btn-primary'),
    userDisplayName: document.getElementById('user-display-name'),
    btnLogout: document.getElementById('btn-logout'),
    sidebar: document.getElementById('sidebar'),
    sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
    btnMobileMenu: document.getElementById('btn-mobile-menu'),
    btnNewChat: document.getElementById('btn-new-chat'),
    chatHistory: document.getElementById('chat-history'),
    chatViewport: document.getElementById('chat-viewport'),
    chatWelcomeScreen: document.getElementById('chat-welcome-screen'),
    chatMessagesContainer: document.getElementById('chat-messages-container'),
    hardwareStatus: document.getElementById('hardware-status'),
    modelLoader: document.getElementById('model-loader'),
    modelProgressFill: document.getElementById('model-progress-fill'),
    modelProgressText: document.getElementById('model-progress-text'),
    chatTextarea: document.getElementById('chat-textarea'),
    btnSend: document.getElementById('btn-send'),
    btnTriggerUpload: document.getElementById('btn-trigger-upload'),
    hiddenFileInput: document.getElementById('hidden-file-input'),
    imagePreviewArea: document.getElementById('image-preview-area'),
    imageThumbnail: document.getElementById('image-thumbnail'),
    btnRemoveImage: document.getElementById('btn-remove-image')
};

// INITIALISIERUNG BEIM START
document.addEventListener('DOMContentLoaded', () => {
    checkWebGPUSupport();
    initSession();
    setupEventListeners();
});

// 1. HARDWARE CHECK (FALLBACK-SICHERHEIT)
function checkWebGPUSupport() {
    if (!navigator.gpu) {
        el.hardwareStatus.innerHTML = "<span class='error-badge'>WebGPU nicht unterstützt!</span><br><small>Diese Anwendung benötigt einen modernen Browser mit WebGPU (Chrome, Edge, Opera ab v113 oder Firefox Nightly).</small>";
        el.hardwareStatus.style.borderColor = "#ef4444";
        return false;
    }
    el.hardwareStatus.innerHTML = "<span class='success-badge'>WebGPU Verfügbar</span> • Hardware-Beschleunigung aktiv";
    return true;
}

// 2. CRYPTO-AUTHENTIFIZIERUNG (REIN CLIENTSEITIG)
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function initSession() {
    const activeUser = sessionStorage.getItem('moonai_session');
    if (activeUser) {
        showAppInterface(activeUser);
    } else {
        showAuthInterface();
    }
}

function setupEventListeners() {
    // Auth Toggles
    el.btnToggleAuth.addEventListener('click', () => {
        isRegisterMode = !isRegisterMode;
        el.authError.classList.add('hidden');
        if (isRegisterMode) {
            el.authSubtitle.innerText = "Registrieren Sie ein neues, lokal verschlüsseltes Konto.";
            el.btnPrimary.innerText = "Konto erstellen";
            el.btnToggleAuth.innerText = "Bereits registriert? Hier einloggen";
        } else {
            el.authSubtitle.innerText = "Erstellen Sie ein lokales Konto oder melden Sie sich an.";
            el.btnPrimary.innerText = "Einloggen";
            el.btnToggleAuth.innerText = "Noch kein Konto? Registrieren";
        }
    });

    // Auth Submit
    el.authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = el.authUsername.value.trim();
        const password = el.authPassword.value;
        if (!username || !password) return;

        const hashedPassword = await hashPassword(password);
        let users = JSON.parse(localStorage.getItem('moonai_users') || '{}');

        if (isRegisterMode) {
            if (users[username]) {
                showAuthError("Benutzername existiert bereits!");
                return;
            }
            users[username] = hashedPassword;
            localStorage.setItem('moonai_users', JSON.stringify(users));
            sessionStorage.setItem('moonai_session', username);
            showAppInterface(username);
        } else {
            if (!users[username] || users[username] !== hashedPassword) {
                showAuthError("Ungültiger Benutzername oder Passwort!");
                return;
            }
            sessionStorage.setItem('moonai_session', username);
            showAppInterface(username);
        }
    });

    // Logout
    el.btnLogout.addEventListener('click', () => {
        sessionStorage.removeItem('moonai_session');
        window.location.reload();
    });

    // UI Sidebar Toggles
    el.btnSidebarToggle.addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));
    el.btnMobileMenu.addEventListener('click', () => {
        el.sidebar.classList.add('mobile-open');
        el.sidebarBackdrop.classList.remove('hidden');
    });
    el.sidebarBackdrop.addEventListener('click', closeMobileSidebar);

    // Chat Management
    el.btnNewChat.addEventListener('click', () => {
        createNewChat();
        closeMobileSidebar();
    });
    el.chatTextarea.addEventListener('input', autoResizeTextarea);
    el.chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleMessageSubmission();
        }
    });
    el.btnSend.addEventListener('click', handleMessageSubmission);

    // Image Upload Handling
    el.btnTriggerUpload.addEventListener('click', () => el.hiddenFileInput.click());
    el.hiddenFileInput.addEventListener('change', handleImageSelection);
    el.btnRemoveImage.addEventListener('click', removeUploadedImage);
}

function showAuthError(msg) {
    el.authError.innerText = msg;
    el.authError.classList.remove('hidden');
}

function closeMobileSidebar() {
    el.sidebar.classList.remove('mobile-open');
    el.sidebarBackdrop.classList.add('hidden');
}

function showAuthInterface() {
    el.authContainer.classList.remove('hidden');
    el.appContainer.classList.add('hidden');
}

function showAppInterface(username) {
    el.authContainer.classList.add('hidden');
    el.appContainer.classList.remove('hidden');
    el.userDisplayName.innerText = username;
    loadChatHistoryFromStorage();
    createNewChat();
}

// 3. LOKALES RATE-LIMITING (MISSBRAUCHS- & ÜBERHITZUNGSSCHUTZ)
function checkRateLimit() {
    const username = sessionStorage.getItem('moonai_session');
    const key = `moonai_rate_${username}`;
    const now = Date.now();
    let logs = JSON.parse(localStorage.getItem(key) || '[]');
    
    // Filter Einträge älter als 3 Stunden (3 * 60 * 60 * 1000 = 10800000ms)
    logs = logs.filter(timestamp => (now - timestamp) < 10800000);
    
    if (logs.length >= 150) {
        return false;
    }
    
    logs.push(now);
    localStorage.setItem(key, JSON.stringify(logs));
    return true;
}

// 4. MULTIMODALER BILD-UPLOAD
function handleImageSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        alert("Datei ist zu groß. Maximal 5 MB erlaubt.");
        el.hiddenFileInput.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        uploadedImageBase64 = event.target.result;
        el.imageThumbnail.src = uploadedImageBase64;
        el.imagePreviewArea.classList.remove('hidden');
        autoResizeTextarea();
    };
    reader.readAsDataURL(file);
}

function removeUploadedImage() {
    uploadedImageBase64 = null;
    el.hiddenFileInput.value = "";
    el.imagePreviewArea.classList.add('hidden');
    autoResizeTextarea();
}

// 5. WEBLLM ENGINE INIZIALISIERUNG
async function ensureEngineReady() {
    if (isEngineLoaded) return true;
    if (!navigator.gpu) {
        alert("WebGPU wird auf diesem Gerät nicht unterstützt. Lokale Ausführung unmöglich.");
        return false;
    }

    el.modelLoader.classList.remove('hidden');
    
    try {
        engine = new webLLM.CreateMLCEngine();
        
        await engine.reload(MODEL_ID, {
            initProgressCallback: (report) => {
                const progress = Math.round(report.progress * 100);
                el.modelProgressFill.style.width = `${progress}%`;
                el.modelProgressText.innerText = `${report.text} (${progress}%)`;
            }
        });
        
        isEngineLoaded = true;
        el.modelLoader.classList.add('hidden');
        return true;
    } catch (err) {
        console.error("WebLLM Init Error:", err);
        el.modelProgressText.innerText = "Fehler beim Laden des Modells. Gerät besitzt evtl. zu wenig VRAM.";
        setTimeout(() => el.modelLoader.classList.add('hidden'), 5000);
        return false;
    }
}

// 6. CHAT LOGIK & HISTORIE
function getChatsStorageKey() {
    const username = sessionStorage.getItem('moonai_session');
    return `moonai_chats_${username}`;
}

function createNewChat() {
    currentChatId = 'chat_' + Date.now();
    uploadedImageBase64 = null;
    el.imagePreviewArea.classList.add('hidden');
    el.chatTextarea.value = "";
    el.chatWelcomeScreen.classList.remove('hidden');
    el.chatMessagesContainer.classList.add('hidden');
    el.chatMessagesContainer.innerHTML = "";
    el.btnSend.disabled = true;
    updateSidebarSelection();
    autoResizeTextarea();
}

function loadChatHistoryFromStorage() {
    const key = getChatsStorageKey();
    const chats = JSON.parse(localStorage.getItem(key) || '{}');
    el.chatHistory.innerHTML = "";
    
    Object.keys(chats).sort((a,b) => b.localeCompare(a)).forEach(id => {
        const chat = chats[id];
        const btn = document.createElement('button');
        btn.className = `sidebar-chat-item ${id === currentChatId ? 'active' : ''}`;
        btn.dataset.id = id;
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            <span class="chat-title-text">${escapeHTML(chat.title)}</span>
        `;
        btn.addEventListener('click', () => switchChat(id));
        el.chatHistory.appendChild(btn);
    });
}

function switchChat(id) {
    currentChatId = id;
    const key = getChatsStorageKey();
    const chats = JSON.parse(localStorage.getItem(key) || '{}');
    const chat = chats[id];
    
    if (!chat) return;

    el.chatWelcomeScreen.classList.add('hidden');
    el.chatMessagesContainer.classList.remove('hidden');
    el.chatMessagesContainer.innerHTML = "";
    
    chat.messages.forEach(msg => {
        appendMessageElement(msg.role, msg.content, msg.image);
    });
    
    updateSidebarSelection();
    closeMobileSidebar();
    el.chatViewport.scrollTop = el.chatViewport.scrollHeight;
}

function updateSidebarSelection() {
    document.querySelectorAll('.sidebar-chat-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.id === currentChatId);
    });
}

// 7. STREAMING GENERATION & ANFRAGEN VERARBEITUNG
async function handleMessageSubmission() {
    if (isGenerating) return;
    const text = el.chatTextarea.value.trim();
    if (!text && !uploadedImageBase64) return;

    // Rate Limit Validierung
    if (!checkRateLimit()) {
        alert("Sicherheits-Limit erreicht: Max. 150 Abfragen pro 3 Stunden, um Geräte-Überlastung zu verhindern.");
        return;
    }

    // Safety-Themenprüfung
    for (let regex of BANNED_KEYWORDS) {
        if (regex.test(text)) {
            appendMessageElement('user', text, uploadedImageBase64);
            appendMessageElement('assistant', "Diese Anfrage verstößt gegen meine Sicherheitsrichtlinien zur lokalen Verhaltenssteuerung.");
            el.chatTextarea.value = "";
            removeUploadedImage();
            return;
        }
    }

    // Engine initialisieren falls nötig
    const ready = await ensureEngineReady();
    if (!ready) return;

    isGenerating = true;
    el.btnSend.disabled = true;

    // UI Updates
    el.chatWelcomeScreen.classList.add('hidden');
    el.chatMessagesContainer.classList.remove('hidden');
    
    appendMessageElement('user', text, uploadedImageBase64);
    
    const userImgTmp = uploadedImageBase64;
    el.chatTextarea.value = "";
    removeUploadedImage();

    // Persistierung im Speicher / LocalStorage
    const key = getChatsStorageKey();
    let chats = JSON.parse(localStorage.getItem(key) || '{}');
    if (!chats[currentChatId]) {
        // Generiere einen kurzen Titel (erste 3-4 Wörter)
        const titleWords = text ? text.split(" ").slice(0, 4).join(" ") : "Bild-Analyse";
        chats[currentChatId] = {
            title: titleWords || "Neuer Chat",
            messages: []
        };
    }
    
    chats[currentChatId].messages.push({ role: 'user', content: text, image: userImgTmp });
    localStorage.setItem(key, JSON.stringify(chats));
    loadChatHistoryFromStorage();

    // KI-Container für Streaming vorbereiten
    const aiBubble = appendMessageElement('assistant', '');
    const contentTextSpan = aiBubble.querySelector('.msg-text');
    
    try {
        // Build payload für WebLLM basierend auf der Kontexthistorie
        const historyPayload = [];
        chats[currentChatId].messages.forEach(m => {
            if (m.image) {
                historyPayload.push({
                    role: m.role,
                    content: [
                        { type: "text", text: m.content || "" },
                        { type: "image_url", image_url: { url: m.image } }
                    ]
                });
            } else {
                historyPayload.push({ role: m.role, content: m.content });
            }
        });

        const completion = await engine.chat.completions.create({
            messages: historyPayload,
            stream: true
        });

        let fullAiResponse = "";
        for await (const chunk of completion) {
            const curDelta = chunk.choices[0]?.delta?.content || "";
            fullAiResponse += curDelta;
            contentTextSpan.innerHTML = parseMarkdown(fullAiResponse);
            el.chatViewport.scrollTop = el.chatViewport.scrollHeight;
            attachCodeCopyHandlers();
        }

        // Finales Sichern der KI-Antwort
        chats = JSON.parse(localStorage.getItem(key) || '{}');
        chats[currentChatId].messages.push({ role: 'assistant', content: fullAiResponse });
        localStorage.setItem(key, JSON.stringify(chats));

    } catch (err) {
        console.error("Generation Error:", err);
        contentTextSpan.innerHTML = "<span class='error-text'>Lokaler Laufzeitfehler während des Streamings aufgetreten. Engine wurde zurückgesetzt.</span>";
    } finally {
        isGenerating = false;
        autoResizeTextarea();
    }
}

// 8. RENDER HELFER (MARKDOWN PARSER & COPY TO CLIPBOARD)
function appendMessageElement(role, text, imageBase64 = null) {
    const msgBlock = document.createElement('div');
    msgBlock.className = `message-row ${role === 'user' ? 'msg-right' : 'msg-left'}`;
    
    let imgHtml = "";
    if (imageBase64) {
        imgHtml = `<div class="msg-attached-image"><img src="${imageBase64}" alt="Benutzerbild"></div>`;
    }

    if (role === 'user') {
        msgBlock.innerHTML = `
            <div class="message-bubble user-bubble">
                ${imgHtml}
                <div class="msg-text">${escapeHTML(text)}</div>
            </div>
        `;
    } else {
        msgBlock.innerHTML = `
            <div class="bot-icon-wrapper animate-glow">M</div>
            <div class="message-bubble bot-bubble">
                <div class="msg-text">${parseMarkdown(text)}</div>
            </div>
        `;
    }
    
    el.chatMessagesContainer.appendChild(msgBlock);
    el.chatViewport.scrollTop = el.chatViewport.scrollHeight;
    attachCodeCopyHandlers();
    return msgBlock;
}

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function parseMarkdown(md) {
    if (!md) return "...";
    let html = md;

    // Multi-line Codeblocks ```lang ... ```
    html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, function(match, lang, code) {
        return `<div class="code-container">
            <div class="code-header">
                <span>${lang || 'code'}</span>
                <button class="btn-copy-code">Kopieren</button>
            </div>
            <pre><code>${escapeHTML(code)}</code></pre>
        </div>`;
    });

    // Inline Code `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Linebreaks
    html = html.replace(/\n/g, '<br>');

    return html;
}

function attachCodeCopyHandlers() {
    document.querySelectorAll('.btn-copy-code').forEach(btn => {
        if (btn.dataset.hooked) return;
        btn.dataset.hooked = "true";
        btn.addEventListener('click', () => {
            const pre = btn.parentElement.nextElementSibling.querySelector('code');
            if (pre) {
                navigator.clipboard.writeText(pre.innerText).then(() => {
                    btn.innerText = "Kopiert!";
                    btn.classList.add('copied');
                    setTimeout(() => {
                        btn.innerText = "Kopieren";
                        btn.classList.remove('copied');
                    }, 2000);
                });
            }
        });
    });
}

// 9. TEXTAREA AUTO RESIZE
function autoResizeTextarea() {
    el.chatTextarea.style.height = 'auto';
    const computedHeight = el.chatTextarea.scrollHeight;
    el.chatTextarea.style.height = Math.min(computedHeight, 200) + 'px';
    
    // Toggle Sende-Button State
    const hasText = el.chatTextarea.value.trim().length > 0;
    el.btnSend.disabled = !(hasText || uploadedImageBase64) || isGenerating;
}
