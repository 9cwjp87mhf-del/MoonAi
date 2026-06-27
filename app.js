// MoonAi PWA Frontend - Simplified
let currentChatId = null;
let selectedFiles = [];

const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const imageUpload = document.getElementById('image-upload');
const imagePreview = document.getElementById('image-preview');
const chatList = document.getElementById('chat-list');
const newChatBtn = document.getElementById('new-chat');
const logoutBtn = document.getElementById('logout');

// Mock functions for standalone PWA demo (connect to your backend in production)
async function loadChats() {
    // In real app: fetch from /api/chat
    console.log('Chats loaded (demo)');
}

async function loadChat(id) {
    currentChatId = id;
    console.log('Loading chat', id);
}

function appendMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.role}`;
    div.innerHTML = msg.role === 'model' ? 
        `<p>${msg.content || 'Antwort vom KI...'}</p>` : 
        `<p>${msg.content}</p>`;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

imageUpload.addEventListener('change', (e) => {
    selectedFiles = Array.from(e.target.files);
    imagePreview.innerHTML = '';
    selectedFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = ev => {
            const img = document.createElement('img');
            img.src = ev.target.result;
            img.className = 'preview-img';
            imagePreview.appendChild(img);
        };
        reader.readAsDataURL(file);
    });
});

messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!messageInput.value.trim() && selectedFiles.length === 0) return;

    appendMessage({ role: 'user', content: messageInput.value });
    
    // Simulate AI response
    setTimeout(() => {
        appendMessage({ 
            role: 'model', 
            content: 'Das ist eine Demo-Antwort von MoonAi. In der vollen Version wird hier Gemini streamen.' 
        });
    }, 800);

    messageInput.value = '';
    imagePreview.innerHTML = '';
    selectedFiles = [];
});

newChatBtn.addEventListener('click', () => {
    currentChatId = 'demo-' + Date.now();
    messagesContainer.innerHTML = '';
    loadChats();
});

logoutBtn.addEventListener('click', () => {
    alert('In voller Version: Logout & Redirect');
});

// Init
loadChats();
console.log('MoonAi PWA ready!');