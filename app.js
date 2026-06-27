// State Management für Sessions, Historie und KI
const currentUser = "lokal_user"; // Permanenter anonymer Speicher-Namespace
let currentChatId = null;
let chatHistories = {}; // Format: { username: { chatId: { title: "", messages: [] } } }
let currentImageBase64 = null;
let webLLMEngine = null;

// Offizielles performantes WebLLM Modell für Browser WebGPU Execution
const SELECTED_MODEL = "Phi-3-mini-4k-instruct-q4f32_1-MLC"; 

// DOM-Elemente abgreifen
const chatContainer = document.getElementById('chat-container');
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const closeSidebarMobile = document.getElementById('close-sidebar-mobile');
const newChatBtn = document.getElementById('new-chat-btn');
const chatHistoryList = document.getElementById('chat-history-list');
const currentUserDisplay = document.getElementById('current-user-display');

const modelStatus = document.getElementById('model-status');
const modelProgressContainer = document.getElementById('model-progress-container');
const progressText = document.getElementById('progress-text');
const progressPercentage = document.getElementById('progress-percentage');
const modelProgressBar = document.getElementById('model-progress-bar');

const chatMessagesArea = document.getElementById('chat-messages-area');
const chatTextarea = document.getElementById('chat-textarea');
const sendMessageBtn = document.getElementById('send-message-btn');

const imageUploadInput = document.getElementById('image-upload-input');
const imagePreviewBox = document.getElementById('image-preview-box');
const imagePreviewThumbnail = document.getElementById('image-preview-thumbnail');
const removeImageBtn = document.getElementById('remove-image-btn');

// TABU-THEMEN & MODERATION (SAFETY SETTINGS)
const TABOO_KEYWORDS = [
    "bombe bauen", "waffen herstellen", "illegal drogen", "malware schreiben", 
    "phishing seite", "computervirus", "terroranschlag", "amoklauf"
];

// INITIALISIERUNG BEIM LADEN DER SEITE
document.addEventListener('DOMContentLoaded', () => {
    loadChatHistoriesFromStorage();
    
    // Initialisiere Historie des lokalen Modus falls leer
    if (!chatHistories[currentUser]) {
        chatHistories[currentUser] = {};
        saveChatHistoriesToStorage();
    }

    currentUserDisplay.textContent = "Lokaler Modus";
    setupEventListeners();
    renderSidebarHistory();
    startNewChatSession();
    adjustTextareaHeight();
    
    // Direktes Starten der Client-Side WebKI
    initClientSideAI();
});

// EVENT LISTENER STRUKTURIERT EINRICHTEN
function setupEventListeners() {
    // Sidebar Toggles
    toggleSidebarBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        sidebar.classList.toggle('active');
    });
    closeSidebarMobile.addEventListener('click', () => {
        sidebar.classList.remove('active');
    });

    // Chat Management
    newChatBtn.addEventListener('click', () => {
        startNewChatSession();
        if (window.innerWidth <= 768) sidebar.classList.remove('active');
    });

    // Textarea & Senden
    chatTextarea.addEventListener('input', () => {
        adjustTextareaHeight();
        toggleSendButtonState();
    });

    chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendMessageBtn.disabled) {
                processUserMessage();
            }
        }
    });

    sendMessageBtn.addEventListener('click', processUserMessage);

    // Multimodaler Bild-Upload
    imageUploadInput.addEventListener('change', handleImageUpload);
    removeImageBtn.addEventListener('click', clearImageUpload);
}

// STORAGE-LOGIK FÜR HISTORIE
function loadChatHistoriesFromStorage() {
    chatHistories = JSON.parse(localStorage.getItem('moonai_histories') || '{}');
}

function saveChatHistoriesToStorage() {
    localStorage.setItem('moonai_histories', JSON.stringify(chatHistories));
}

// WEBLLM CLIENT-SIDE AI INTEGRATION (MISTRAL/PHI WEBGPU)
async function initClientSideAI() {
    if (!navigator.gpu) {
        modelStatus.textContent = "Fehler: WebGPU nicht unterstützt";
        modelStatus.style.color = "var(--text-error)";
        alert("WebGPU wird auf diesem Browser oder Gerät nicht unterstützt. Bitte nutze ein modernes Endgerät mit Chrome/Edge und aktivierter Hardwarebeschleunigung.");
        return;
    }

    modelStatus.textContent = "Initialisiere Engine...";
    modelProgressContainer.classList.remove('hidden');

    try {
        const result = await window.webllm.CreateEngine(SELECTED_MODEL, {
            initProgressCallback: (report) => {
                const percentage = Math.round(report.progress * 100);
                progressPercentage.textContent = `${percentage}%`;
                modelProgressBar.style.width = `${percentage}%`;
                progressText.textContent = report.text;
                
                if (percentage >= 100) {
                    setTimeout(() => {
                        modelProgressContainer.classList.add('hidden');
                        modelStatus.textContent = "Bereit (Lokal)";
                        toggleSendButtonState();
                    }, 1000);
                }
            }
        });
        
        webLLMEngine = result;
    } catch (error) {
        console.error("Fehler beim Laden des WebLLM Modells:", error);
        modelStatus.textContent = "Fehler beim Laden des Modells";
        modelStatus.style.color = "var(--text-error)";
        progressText.textContent = "Fehler: " + error.message;
    }
}

// LOKALES RATE-LIMITING (Max 150 Nachrichten pro 3 Stunden)
function checkRateLimit() {
    const limitKey = `moonai_ratelimit_${currentUser.toLowerCase()}`;
    let messageTimestamps = JSON.parse(localStorage.getItem(limitKey) || '[]');
    
    const now = Date.now();
    const threeHoursAgo = now - (3 * 60 * 60 * 1000);
    
    messageTimestamps = messageTimestamps.filter(timestamp => timestamp > threeHoursAgo);
    
    if (messageTimestamps.length >= 150) {
        return false;
    }
    
    messageTimestamps.push(now);
    localStorage.setItem(limitKey, JSON.stringify(messageTimestamps));
    return true;
}

// SAFETY SETTINGS & TABU-THEMEN CHECK
function validateSafetyPolicy(text) {
    const lowerText = text.toLowerCase();
    for (const keyword of TABOO_KEYWORDS) {
        if (lowerText.includes(keyword)) {
            return false;
        }
    }
    return true;
}

// CHAT VERLAUF LOGIK & DOM RENDERING
function startNewChatSession() {
    currentChatId = 'chat_' + Date.now();
    chatHistories[currentUser][currentChatId] = {
        title: "Neuer Chat",
        messages: []
    };
    saveChatHistoriesToStorage();
    renderSidebarHistory();
    clearChatScreen();
}

function clearChatScreen() {
    chatMessagesArea.innerHTML = `
        <div id="empty-state" class="empty-state">
            <div class="empty-logo">MoonAi</div>
            <p class="empty-subtitle">100% Client-Side. Deine Daten verlassen niemals dein Gerät.</p>
            <div class="specs-badge">Mistral / Phi WebGPU Engine</div>
        </div>
    `;
    clearImageUpload();
    chatTextarea.value = '';
    adjustTextareaHeight();
    toggleSendButtonState();
}

function renderSidebarHistory() {
    chatHistoryList.innerHTML = '';
    const userChats = chatHistories[currentUser] || {};
    
    const sortedChatIds = Object.keys(userChats).sort((a, b) => b.localeCompare(a));
    
    sortedChatIds.forEach(id => {
        const chat = userChats[id];
        const item = document.createElement('div');
        item.className = `history-item ${id === currentChatId ? 'active' : ''}`;
        item.setAttribute('data-id', id);
        
        const titleSpan = document.createElement('span');
        titleSpan.className = 'history-item-text';
        titleSpan.textContent = chat.title || "Neuer Chat";
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-chat-btn';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Chat löschen';
        
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteChatSession(id);
        });
        
        item.appendChild(titleSpan);
        item.appendChild(deleteBtn);
        
        item.addEventListener('click', () => {
            loadChatSession(id);
            if (window.innerWidth <= 768) sidebar.classList.remove('active');
        });
        
        chatHistoryList.appendChild(item);
    });
}

function loadChatSession(id) {
    currentChatId = id;
    renderSidebarHistory();
    
    const messages = chatHistories[currentUser][id].messages;
    
    if (messages.length === 0) {
        clearChatScreen();
        return;
    }
    
    chatMessagesArea.innerHTML = '';
    messages.forEach(msg => {
        appendMessageToDOM(msg.role, msg.content, msg.image);
    });
    
    scrollToBottom();
    toggleSendButtonState();
}

function deleteChatSession(id) {
    delete chatHistories[currentUser][id];
    saveChatHistoriesToStorage();
    
    if (currentChatId === id) {
        const remainingIds = Object.keys(chatHistories[currentUser]);
        if (remainingIds.length > 0) {
            loadChatSession(remainingIds[0]);
        } else {
            startNewChatSession();
        }
    } else {
        renderSidebarHistory();
    }
}

// MULTIMODALER BILD UPLOAD (Max 5MB)
function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        alert("Das Bild ist zu groß. Maximale erlaubte Größe ist 5MB.");
        imageUploadInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        currentImageBase64 = event.target.result;
        imagePreviewThumbnail.src = currentImageBase64;
        imagePreviewBox.classList.remove('hidden');
        toggleSendButtonState();
    };
    reader.readAsDataURL(file);
}

function clearImageUpload() {
    currentImageBase64 = null;
    imageUploadInput.value = '';
    imagePreviewBox.classList.add('hidden');
    imagePreviewThumbnail.src = '';
    toggleSendButtonState();
}

// HILFSFUNKTIONEN FÜR TEXTAREA-LOGIK
function adjustTextareaHeight() {
    chatTextarea.style.height = 'auto';
    chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 200) + 'px';
}

function toggleSendButtonState() {
    const hasText = chatTextarea.value.trim().length > 0;
    const hasImage = currentImageBase64 !== null;
    const isModelReady = webLLMEngine !== null;
    
    sendMessageBtn.disabled = !(isModelReady && (hasText || hasImage));
}

// PARSING VON MARKDOWN & CODE BLOCKS + COPYSCRIPT
function parseMarkdownToHTML(text) {
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const codeBlockRegex = /```(\w*)\n([\s\S]*?)(```|$)/g;
    let formatted = escaped.replace(codeBlockRegex, (match, lang, code) => {
        const languageName = lang || 'code';
        const cleanCode = code.trim();
        return `
            <div class="code-header">
                <span>${languageName}</span>
                <button class="copy-btn" onclick="copyCodeSnippet(this)">Kopieren</button>
            </div>
            <pre><code class="language-${languageName}">${cleanCode}</code></pre>
        `;
    });

    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/\n/g, '<br>');

    return formatted;
}

window.copyCodeSnippet = function(button) {
    const pre = button.parentElement.nextElementSibling;
    const code = pre.querySelector('code').textContent;

    navigator.clipboard.writeText(code).then(() => {
        const originalText = button.textContent;
        button.textContent = 'Kopiert!';
        button.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
        button.style.color = '#ffffff';
        
        setTimeout(() => {
            button.textContent = originalText;
            button.style.backgroundColor = 'transparent';
            button.style.color = 'var(--text-muted)';
        }, 2000);
    }).catch(err => {
        console.error('Fehler beim Kopieren:', err);
    });
};

function scrollToBottom() {
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

function appendMessageToDOM(role, content, imageSrc = null) {
    const emptyStateElement = document.getElementById('empty-state');
    if (emptyStateElement) emptyStateElement.remove();

    const row = document.createElement('div');
    row.className = `message-row ${role === 'user' ? 'user-row' : 'bot-row'}`;

    if (role === 'assistant') {
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar bot-avatar';
        avatar.textContent = '🌕';
        row.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (imageSrc) {
        const img = document.createElement('img');
        img.src = imageSrc;
        img.className = 'message-image-attach';
        bubble.appendChild(img);
    }

    if (role === 'user') {
        const p = document.createElement('p');
        p.textContent = content;
        bubble.appendChild(p);
    } else {
        bubble.innerHTML += parseMarkdownToHTML(content);
    }

    row.appendChild(bubble);
    chatMessagesArea.appendChild(row);
    scrollToBottom();
    
    return bubble;
}

async function processUserMessage() {
    const text = chatTextarea.value.trim();
    const image = currentImageBase64;

    if (!text && !image) return;

    if (!checkRateLimit()) {
        alert("Lokales Limit erreicht! Du kannst maximal 150 Anfragen alle 3 Stunden senden, um dein Endgerät zu schützen.");
        return;
    }

    if (text && !validateSafetyPolicy(text)) {
        appendMessageToDOM('user', text, image);
        appendMessageToDOM('assistant', "Diese Anfrage verstößt gegen meine Sicherheitsrichtlinien.");
        chatTextarea.value = '';
        clearImageUpload();
        adjustTextareaHeight();
        return;
    }

    appendMessageToDOM('user', text, image);
    
    const chatSession = chatHistories[currentUser][currentChatId];
    chatSession.messages.push({ role: 'user', content: text, image: image });

    if (chatSession.messages.length === 1) {
        const words = text ? text.split(' ').slice(0, 4).join(' ') : "Bild-Analyse";
        chatSession.title = words || "Neuer Chat";
        renderSidebarHistory();
    }

    chatTextarea.value = '';
    clearImageUpload();
    adjustTextareaHeight();
    toggleSendButtonState();

    const botBubble = appendMessageToDOM('assistant', '');
    
    let fullPromptMessages = [];
    chatSession.messages.forEach(m => {
        let structuredContent = m.content;
        if (m.image && m.role === 'user') {
            structuredContent = `[Lokaler Bild-Kontext angehängt] ${m.content}`;
        }
        fullPromptMessages.push({ role: m.role, content: structuredContent });
    });

    try {
        let fullReply = "";
        
        const replyChunks = await webLLMEngine.chat.completions.create({
            messages: fullPromptMessages,
            stream: true
        });

        for await (const chunk of replyChunks) {
            const delta = chunk.choices[0]?.delta?.content || "";
            fullReply += delta;
            
            botBubble.innerHTML = parseMarkdownToHTML(fullReply);
            scrollToBottom();
        }

        chatSession.messages.push({ role: 'assistant', content: fullReply });
        saveChatHistoriesToStorage();

    } catch (error) {
        console.error("Fehler beim Generieren der Antwort:", error);
        botBubble.innerHTML = `<span style="color: var(--text-error)">Fehler bei der lokalen Ausführung: ${error.message}</span>`;
    }
}