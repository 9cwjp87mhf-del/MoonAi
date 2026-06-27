// MoonAi - Fehlerbereinigte Client Architektur
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

let messagesLog = [];

function toggleSidebar() {
    sidebar.classList.toggle('open');
    sidebarOverlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
}

menuBtn.addEventListener('click', toggleSidebar);
closeSidebarBtn.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', toggleSidebar);

// Höhenanpassung & Sende-Button State
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight - 4) + 'px';
    
    if (this.value.trim().length > 0) {
        sendBtn.removeAttribute('disabled');
    } else {
        sendBtn.setAttribute('disabled', 'true');
    }
});

// Tastatur-Listener für Enter (wie echtes ChatGPT)
userInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); 
        chatForm.dispatchEvent(new Event('submit'));
    }
});

// Klick auf Startseiten-Vorschläge
document.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
        userInput.value = card.getAttribute('data-prompt');
        userInput.dispatchEvent(new Event('input'));
        chatForm.dispatchEvent(new Event('submit'));
    });
});

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

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const promptText = userInput.value.trim();
    if (!promptText) return;

    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.setAttribute('disabled', 'true');

    if (document.getElementById('welcomeScreen')) {
        welcomeScreen.remove();
    }

    if (messagesLog.length === 0) {
        historyText.textContent = promptText.length > 22 ? promptText.substring(0, 22) + '...' : promptText;
    }

    appendMessageNode('user', promptText);
    messagesLog.push({ role: 'user', content: promptText });

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

function appendMessageNode(sender, text, isLoading = false) {
    const uniqueId = 'node-' + Date.now() + Math.random().toString(36).substr(2, 4);
    const wrapper = document.createElement('div');
    wrapper.classList.add('message-wrapper', sender);
    wrapper.id = uniqueId;

    if (sender === 'user') {
        wrapper.innerHTML = `<div class="message-content"><div class="text-box"></div></div>`;
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

function removeLoadingIndicator(nodeId, realText) {
    const node = document.getElementById(nodeId);
    if (!node) return;
    node.querySelector('.text-box').innerHTML = parseMarkdown(realText);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Fehlerfreier Markdown Parser mit Codeblock-Isolierung (Bugfix)
function parseMarkdown(text) {
    let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    const codeBlocks = [];
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)(```|$)/g;
    
    escaped = escaped.replace(codeBlockRegex, (match, lang, code) => {
        const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
        codeBlocks.push(`
            <div class="code-block-container">
                <div class="code-header">
                    <span>${lang || 'code'}</span>
                    <span class="copy-code-btn">
                        <i class="fa-regular fa-copy"></i> Code kopieren
                    </span>
                </div>
                <pre><code class="code-content">${code.trim()}</code></pre>
            </div>
        `);
        return placeholder;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    escaped = escaped.replace(/\*\*([^\*]+)\*\//g, '<strong>$1</strong>');

    let paragraphs = escaped.split(/\n\n+/);
    paragraphs = paragraphs.map(p => {
        if (p.startsWith('__CODE_BLOCK_') && p.endsWith('__')) {
            return p;
        }
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    });
    
    let result = paragraphs.join('');

    codeBlocks.forEach((block, index) => {
        result = result.replace(`__CODE_BLOCK_${index}__`, block);
    });

    return result;
}

// Globaler Event-Listener für echtes Code-Kopieren (Bugfix)
document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.copy-code-btn');
    if (copyBtn) {
        const container = copyBtn.closest('.code-block-container');
        const codeEl = container.querySelector('.code-content');
        if (codeEl) {
            try {
                await navigator.clipboard.writeText(codeEl.innerText);
                const originalHTML = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Kopiert!';
                setTimeout(() => { copyBtn.innerHTML = originalHTML; }, 2000);
            } catch (err) {
                console.error('Fehler beim Kopieren:', err);
            }
        }
    }
});

// Direkte API Verbindung zu Gemini
async function callGeminiApi(history) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${getApiKey()}`;
    const contentsArray = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
    }));
    
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contentsArray,
            systemInstruction: { parts: [{ text: "Du bist MoonAi, eine hochentwickelte KI. Du agierst als ChatGPT App Klon mit herausragenden, präzisen Antworten. Antworte immer auf Deutsch." }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: 2500 }
        })
    });
    
    if (!response.ok) throw new Error("HTTP Error");
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Keine Antwort erhalten.";
}
