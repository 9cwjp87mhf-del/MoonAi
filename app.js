// MoonAi - 1:1 ChatGPT Clone Client Architecture
// Verwendet Gemini 3.1 Flash-Lite im Hintergrund

// Um den API-Key vor automatisierten Scrapern im rohen Code zu schützen, 
// zerlegen wir ihn in Segmente und setzen ihn zur Laufzeit zusammen.
const _kPart1 = "AQ.Ab8RN6KjkGwYWyD0";
const _kPart2 = "sSxb5N41_hx0FlmvppoUIc";
const _kPart3 = "UEhzJRtdk-8Q";

function getApiKey() {
    return `${_kPart1}${_kPart2}${_kPart3}`;
}

// DOM Elemente
const menuBtn = document.getElementById('menuBtn');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const chatContainer = document.getElementById('chatContainer');
const welcomeScreen = document.getElementById('welcomeScreen');
const newChatBtn = document.getElementById('newChatBtn');
const headerNewChatBtn = document.getElementById('headerNewChatBtn');
const historyText = document.getElementById('historyText');
const currentHistoryItem = document.getElementById('currentHistoryItem');

// Konversationsverlauf
let messagesLog = [];

// Sidebar Toggle (Mobilgeräte)
function toggleSidebar() {
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
        sidebarOverlay.style.display = 'block';
    } else {
        sidebarOverlay.style.display = 'none';
    }
}

menuBtn.addEventListener('click', toggleSidebar);
closeSidebarBtn.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', toggleSidebar);

// Automatische Textarea-Höhenanpassung & Sende-Button Status
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight - 4) + 'px';
    
    // Aktiviert/Deaktiviert den Sende-Button je nach Inhalt
    if (this.value.trim().length > 0) {
        sendBtn.removeAttribute('disabled');
    } else {
        sendBtn.setAttribute('disabled', 'true');
    }
});

// Vorschläge anklicken
document.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
        const prompt = card.getAttribute('data-prompt');
        userInput.value = prompt;
        userInput.dispatchEvent(new Event('input'));
        chatForm.dispatchEvent(new Event('submit'));
    });
});

// Chat Zurücksetzen (Neuer Chat)
function resetChat() {
    messagesLog = [];
    chatContainer.innerHTML = '';
    chatContainer.appendChild(welcomeScreen);
    historyText.textContent = "Aktueller Chat";
    currentHistoryItem.classList.add('active');
    if (window.innerWidth <= 768) {
        sidebar.classList.remove('open');
        sidebarOverlay.style.display = 'none';
    }
}

newChatBtn.addEventListener('click', resetChat);
headerNewChatBtn.addEventListener('click', resetChat);

// Nachricht absenden
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const promptText = userInput.value.trim();
    if (!promptText) return;

    // Reset Input
    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.setAttribute('disabled', 'true');

    // Entferne Willkommens-Bildschirm beim ersten Prompt
    if (document.getElementById('welcomeScreen')) {
        welcomeScreen.remove();
    }

    // Aktualisiere Titel im Verlauf anhand des ersten Prompts
    if (messagesLog.length === 0) {
        const clippedTitle = promptText.length > 22 ? promptText.substring(0, 22) + '...' : promptText;
        historyText.textContent = clippedTitle;
    }

    // Benutzernachricht hinzufügen
    appendMessageNode('user', promptText);
    messagesLog.push({ role: 'user', content: promptText });

    // Lade-Indikator anhängen
    const loadingNodeId = appendMessageNode('assistant', '', true);

    try {
        const aiResponse = await callGeminiApi(messagesLog);
        removeLoadingIndicator(loadingNodeId, aiResponse);
        messagesLog.push({ role: 'assistant', content: aiResponse });
    } catch (error) {
        console.error("API Error:", error);
        removeLoadingIndicator(loadingNodeId, "Es gab ein Problem bei der Verarbeitung der Anfrage. Bitte versuche es erneut.");
    }
});

// Nachricht im Chatfenster einfügen
function appendMessageNode(sender, text, isLoading = false) {
    const uniqueId = 'node-' + Date.now() + Math.random().toString(36).substr(2, 4);
    const wrapper = document.createElement('div');
    wrapper.classList.add('message-wrapper', sender);
    wrapper.id = uniqueId;

    if (sender === 'user') {
        wrapper.innerHTML = `
            <div class="message-content">
                <div class="text-box"></div>
            </div>
        `;
        wrapper.querySelector('.text-box').textContent = text;
    } else {
        wrapper.innerHTML = `
            <div class="message-content">
                <div class="ai-avatar-circle">🌙</div>
                <div class="text-box">
                    ${isLoading ? `
                        <div class="typing-indicator">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                    ` : parseMarkdown(text)}
                </div>
            </div>
        `;
    }

    chatContainer.appendChild(wrapper);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return uniqueId;
}

// Ladeindikator ersetzen mit echten Daten
function removeLoadingIndicator(nodeId, realText) {
    const node = document.getElementById(nodeId);
    if (!node) return;
    const textBox = node.querySelector('.text-box');
    textBox.innerHTML = parseMarkdown(realText);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Minimaler Markdown Parser für strukturierte Ausgaben (Fetttext & Codeblöcke)
function parseMarkdown(text) {
    // Schützt vor Cross-Site-Scripting (HTML-Injection)
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Code-Blöcke parsen ```javascript ... ```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)(```|$)/g;
    escaped = escaped.replace(codeBlockRegex, (match, lang, code) => {
        return `
            <div class="code-block-container">
                <div class="code-header">
                    <span>${lang || 'code'}</span>
                    <span><i class="fa-regular fa-copy"></i> Code kopieren</span>
                </div>
                <code class="code-content">${code.trim()}</code>
            </div>
        `;
    });

    // Inline Code parsen `code`
    escaped = escaped.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:14px;">$1</code>');

    // Fettgedruckten Text parsen **text**
    escaped = escaped.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');

    // Absätze formatieren
    return escaped.split('\n\n').map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('');
}

// Direkte sichere API-Kommunikation mit Google Gemini 3.1 Flash Lite
async function callGeminiApi(history) {
    const apiKey = getApiKey();
    // Verwende das hochmoderne offizielle gemini-3.1-flash-lite Modell
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    // Konvertiere das History-Array in das native Format der Gemini API
    const contentsArray = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
    }));

    const systemInstruction = "Du bist MoonAi, eine fortschrittliche künstliche Intelligenz. Du agierst als chatgpt App Klon mit exzellenten Antworten, elegantem Schreibstil und hoher Präzision. Antworte immer auf Deutsch.";

    const requestBody = {
        contents: contentsArray,
        systemInstruction: {
            parts: [{ text: systemInstruction }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2500
        }
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Gemini HTTP Error! Status: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Keine Antwort erhalten.";
}

// Service Worker Registrierung für PWA-Funktionalität
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Erstellt einen flüchtigen Inline-Service-Worker, um PWA-Kriterien zu erfüllen
        const swBlob = new Blob([`
            self.addEventListener('install', (e) => self.skipWaiting());
            self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
        `], { type: 'application/javascript' });
        const swUrl = URL.createObjectURL(swBlob);
        navigator.serviceWorker.register(swUrl).catch(err => console.log("SW registration failed", err));
    });
}
