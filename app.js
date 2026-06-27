// MoonAi - Frontend Logic
let token = localStorage.getItem('token');
let currentChatId = null;
let currentImage = null;

const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const imageUpload = document.getElementById('image-upload');
const uploadBtn = document.getElementById('upload-btn');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const removeImageBtn = document.getElementById('remove-image');

// Auth
document.getElementById('login-btn').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    // Hier Backend-Call (siehe server.js)
    alert('Login-Funktion wird mit Backend verbunden.');
});

document.getElementById('register-btn').addEventListener('click', () => {
    alert('Registrierung wird mit Backend verbunden.');
});

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('token');
    location.reload();
});

// Image Upload
uploadBtn.addEventListener('click', () => imageUpload.click());

imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return alert('Max. 10MB erlaubt');
    
    currentImage = file;
    const reader = new FileReader();
    reader.onload = ev => {
        previewImg.src = ev.target.result;
        imagePreview.style.display = 'flex';
    };
    reader.readAsDataURL(file);
});

removeImageBtn.addEventListener('click', () => {
    currentImage = null;
    imagePreview.style.display = 'none';
});

// Send Message
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') sendMessage();
});

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text && !currentImage) return;

    // UI Message
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.textContent = text;
    messagesContainer.appendChild(userMsg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    messageInput.value = '';
    // Backend Call würde hier erfolgen
    console.log('Nachricht gesendet mit Bild:', !!currentImage);
}

// Init
if (token) {
    document.getElementById('chat-interface').classList.remove('hidden');
} else {
    document.getElementById('login-screen').classList.remove('hidden');
}