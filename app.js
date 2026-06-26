// ─── Konfiguration ───────────────────────────────────────────────────────────
// Passe BACKEND_URL beim Deployment an, z.B.:
// const BACKEND_URL = 'https://moonai-backend.onrender.com';
const BACKEND_URL = 'http://localhost:3000';

// ─── Zustand ─────────────────────────────────────────────────────────────────
let token = localStorage.getItem('moonai_token');
let selectedFile = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
if (token) {
    showApp();
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
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
    sidebar.classList.toggle('absolute');
    sidebar.classList.toggle('z-40');
    sidebar.classList.toggle('h-full');
}

// ─── File Upload ──────────────────────────────────────────────────────────────
document.getElementById('file-upload').addEventListener('change', function (e) {
    selectedFile = e.target.files[0];
    const preview = document.getElementById('file-preview');
    if (selectedFile) {
        preview.textContent = `Angehängt: ${selectedFile.name}`;
        preview.classList.remove('hidden');
    }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function handleAuth(endpoint) {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');

    if (!email || !password) {
        errorEl.textContent = 'Bitte E-Mail und Passwort eingeben.';
        errorEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/auth/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (data.token) {
            token = data.token;
            localStorage.setItem('moonai_token', token);
            showApp();
        } else {
            errorEl.textContent = data.error || 'Fehler aufgetreten.';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Netzwerkfehler – Server erreichbar?';
        errorEl.classList.remove('hidden');
    }
}

function login() { handleAuth('login'); }
function register() { handleAuth('register'); }

function logout() {
    token = null;
    localStorage.removeItem('moonai_token');
    showAuth();
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
document.getElementById('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message && !selectedFile) return;

    document.getElementById('empty-state').classList.add('hidden');
    appendMessage('user', message, selectedFile);

    input.value = '';
    input.style.height = 'auto';

    const thinkingId = appendThinking();

    const formData = new FormData();
    formData.append('message', message);
    if (selectedFile) {
        formData.append('file', selectedFile);
        selectedFile = null;
        document.getElementById('file-preview').classList.add('hidden');
        document.getElementById('file-upload').value = '';
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
        });

        if (res.status === 401 || res.status === 403) {
            removeThinking(thinkingId);
            logout();
            return;
        }

        const data = await res.json();
        removeThinking(thinkingId);
        appendMessage('ai', data.reply, null, data.imageUrl);
    } catch (err) {
        removeThinking(thinkingId);
        appendMessage('ai', 'Verbindungsfehler zum Server.');
    }
}

function appendMessage(sender, text, file = null, imageUrl = null) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `flex gap-4 ${sender === 'user' ? 'justify-end' : 'justify-start'}`;

    // Sicherheit: Text wird als textContent gesetzt, nicht als innerHTML
    let content = `<div class="p-3 rounded-2xl max-w-[80%] ${sender === 'user' ? 'bg-gray-700' : 'bg-transparent text-gray-200'}">`;
    if (file) {
        const safeName = document.createElement('span');
        safeName.textContent = file.name;
        content += `<div class="text-xs text-blue-400 mb-1"><i class="fa-solid fa-paperclip"></i> ${safeName.outerHTML}</div>`;
    }
    if (text) {
        const safeText = document.createElement('div');
        safeText.textContent = text;
        content += safeText.outerHTML;
    }
    if (imageUrl) {
        // imageUrl kommt vom eigenen Backend – trotzdem als Attribut, nicht innerHTML
        const img = document.createElement('img');
        img.src = imageUrl;
        img.className = 'mt-2 rounded-lg max-w-full h-auto';
        img.alt = 'Generiertes Bild';
        content += img.outerHTML;
    }
    content += '</div>';

    div.innerHTML = content;
    container.appendChild(div);
    document.getElementById('chat-window').scrollTop = document.getElementById('chat-window').scrollHeight;
}

let thinkingCounter = 0;
function appendThinking() {
    const id = 'thinking-' + (++thinkingCounter);
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.id = id;
    div.className = 'flex gap-4 justify-start';
    div.innerHTML = `<div class="p-3 rounded-2xl text-gray-400 text-sm italic">MoonAi denkt…</div>`;
    container.appendChild(div);
    document.getElementById('chat-window').scrollTop = document.getElementById('chat-window').scrollHeight;
    return id;
}

function removeThinking(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}
