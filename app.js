const BACKEND_URL = 'http://localhost:3000';

let token = localStorage.getItem('moonai_token');
let selectedFile = null;
let currentChatId = null;

if (token) {
    showApp();
    loadChatHistory();
}

function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
}

function showAuth() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
}

function autoGrow(element) {
    element.style.height = '5px';
    element.style.height = element.scrollHeight + 'px';
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('hidden');
}

// ─── CHAT HISTORIE LOGIK ─────────────────────────────────────────────────────
async function loadChatHistory() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/chats`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) return logout();
        
        const chats = await res.json();
        const historyContainer = document.getElementById('chat-history');
        historyContainer.innerHTML = '';

        chats.forEach(chat => {
            const wrapper = document.createElement('div');
            wrapper.className = `flex items-center justify-between group px-2 py-1.5 rounded-xl transition \${chat._id === currentChatId ? 'bg-gray-800 text-white font-medium' : 'text-gray-400 hover:bg-gray-850'}`;
            
            const btn = document.createElement('button');
            btn.className = "flex-1 text-left truncate text-xs mr-2";
            btn.textContent = chat.title || 'Konversation';
            btn.onclick = () => loadChat(chat._id);

            const delBtn = document.createElement('button');
            delBtn.className = "opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs transition px-1";
            delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteChat(chat._id);
            };

            wrapper.appendChild(btn);
            wrapper.appendChild(delBtn);
            historyContainer.appendChild(wrapper);
        });
    } catch (err) { console.error('Historienfehler:', err); }
}

async function loadChat(chatId) {
    currentChatId = chatId;
    document.getElementById('empty-state').classList.add('hidden');
    const container = document.getElementById('messages-container');
    container.innerHTML = '<div class="text-center text-gray-500 italic text-xs py-4">Lade Verlauf...</div>';

    try {
        const res = await fetch(`${BACKEND_URL}/api/chats/\${chatId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const chat = await res.json();
        container.innerHTML = '';

        chat.messages.forEach(msg => {
            appendMessage(msg.sender, msg.text, null, msg.imageUrl);
        });
        loadChatHistory();
    } catch (err) {
        container.innerHTML = '<div class="text-center text-red-400 text-xs">Ladefehler.</div>';
    }
}

async function deleteChat(chatId) {
    if (!confirm('Möchtest du diesen Chat dauerhaft löschen?')) return;
    try {
        await fetch(`${BACKEND_URL}/api/chats/\${chatId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (currentChatId === chatId) startNewChat();
        else loadChatHistory();
    } catch (err) { console.error(err); }
}

function startNewChat() {
    currentChatId = null;
    document.getElementById('messages-container').innerHTML = '';
    document.getElementById('empty-state').classList.remove('hidden');
    loadChatHistory();
}

// ─── FILE UPLOAD TRIGGER ─────────────────────────────────────────────────────
document.getElementById('file-upload').addEventListener('change', function (e) {
    selectedFile = e.target.files[0];
    const preview = document.getElementById('file-preview');
    if (selectedFile) {
        preview.textContent = `📎 Datei bereit: \${selectedFile.name} (\${(selectedFile.size/1024/1024).toFixed(2)} MB)`;
        preview.classList.remove('hidden');
    }
});

// ─── AUTH STEUERUNG ──────────────────────────────────────────────────────────
async function handleAuth(endpoint) {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');

    if (!email || !password) {
        errorEl.textContent = 'Bitte fülle alle Felder aus.';
        errorEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`\${BACKEND_URL}/auth/\${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (data.token) {
            token = data.token;
            localStorage.setItem('moonai_token', token);
            showApp();
            startNewChat();
        } else {
            errorEl.textContent = data.error || 'Authentifizierungsfehler.';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Server nicht erreichbar.';
        errorEl.classList.remove('hidden');
    }
}

function login() { handleAuth('login'); }
function register() { handleAuth('register'); }

function logout() {
    token = null;
    currentChatId = null;
    localStorage.removeItem('moonai_token');
    showAuth();
}

// ─── SENDE LOGIK ─────────────────────────────────────────────────────────────
document.getElementById('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    const selectedModel = document.getElementById('model-select').value;
    
    if (!message && !selectedFile) return;

    document.getElementById('empty-state').classList.add('hidden');
    appendMessage('user', message, selectedFile);

    input.value = '';
    input.style.height = 'auto';

    const thinkingId = appendThinking();

    const formData = new FormData();
    formData.append('message', message);
    formData.append('model', selectedModel);
    if (currentChatId) formData.append('chatId', currentChatId);
    
    if (selectedFile) {
        formData.append('file', selectedFile);
        selectedFile = null;
        document.getElementById('file-preview').classList.add('hidden');
        document.getElementById('file-upload').value = '';
    }

    try {
        const res = await fetch(`\${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: { Authorization: `Bearer \${token}` },
            body: formData,
        });

        if (res.status === 401 || res.status === 403) {
            removeThinking(thinkingId);
            return logout();
        }

        const data = await res.json();
        removeThinking(thinkingId);
        
        if (!currentChatId && data.chatId) currentChatId = data.chatId;
        
        appendMessage('ai', data.reply, null, data.imageUrl);
        loadChatHistory();
    } catch (err) {
        removeThinking(thinkingId);
        appendMessage('ai', 'Verbindungsfehler zum Backend-Server.');
    }
}

function appendMessage(sender, text, file = null, imageUrl = null) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `flex gap-4 \${sender === 'user' ? 'justify-end' : 'justify-start'}`;

    let content = `<div class="p-3.5 rounded-2xl max-w-[85%] text-sm \${sender === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100 border border-gray-750'}">`;
    if (file) {
        const safeName = document.createElement('span');
        safeName.textContent = file.name;
        content += `<div class="text-xs opacity-70 mb-1"><i class="fa-solid fa-paperclip mr-1"></i> \${safeName.outerHTML}</div>`;
    }
    if (text) {
        const safeText = document.createElement('div');
        safeText.className = "whitespace-pre-wrap leading-relaxed";
        safeText.textContent = text;
        content += safeText.outerHTML;
    }
    if (imageUrl) {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.className = 'mt-3 rounded-xl max-w-full h-auto border border-gray-700 shadow-md';
        img.alt = 'Generierte Grafik';
        content += img.outerHTML;
    }
    content += '</div>';

    div.innerHTML = content;
    container.appendChild(div);
    const win = document.getElementById('chat-window');
    win.scrollTop = win.scrollHeight;
}

let thinkingCounter = 0;
function appendThinking() {
    const id = 'thinking-' + (++thinkingCounter);
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.id = id;
    div.className = 'flex gap-4 justify-start';
    div.innerHTML = `<div class="p-3 rounded-2xl bg-gray-800 text-gray-400 text-xs italic border border-gray-750 animate-pulse">MoonAi verarbeitet Anfrage...</div>`;
    container.appendChild(div);
    const win = document.getElementById('chat-window');
    win.scrollTop = win.scrollHeight;
    return id;
}

function removeThinking(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}