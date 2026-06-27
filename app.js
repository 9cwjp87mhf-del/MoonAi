// Konfiguration & State Management - SICHER: Kein API Key im Frontend!
const API_URL = "/api/chat"; 

let state = {
    currentUser: null,
    chats: [], 
    currentChatId: null
};

// DOM Elemente
const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const chatList = document.getElementById('chat-list');
const messagesContainer = document.getElementById('messages-container');
const welcomeScreen = document.getElementById('welcome-screen');
const userInput = document.getElementById('user-input');
const chatForm = document.getElementById('chat-form');
const menuToggle = document.getElementById('menu-toggle');
const sidebar = document.getElementById('sidebar');
const closeSidebar = document.getElementById('close-sidebar');

// INIT APP
document.addEventListener('DOMContentLoaded', () => {
    checkPersistedAuth();
    initEventListeners();
});

function initEventListeners() {
    document.getElementById('to-register').addEventListener('click', () => {
        loginForm.classList.add('hidden'); registerForm.classList.remove('hidden');
    });
    document.getElementById('to-login').addEventListener('click', () => {
        registerForm.classList.add('hidden'); loginForm.classList.remove('hidden');
    });

    loginForm.addEventListener('submit', handleLogin);
    registerForm.addEventListener('submit', handleRegister);
    chatForm.addEventListener('submit', handleSendMessage);

    document.getElementById('new-chat-btn').addEventListener('click', () => createNewChat());
    document.getElementById('logout-btn').addEventListener('click', logout);

    userInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    menuToggle.addEventListener('click', () => sidebar.classList.add('open'));
    closeSidebar.addEventListener('click', () => sidebar.classList.remove('open'));
}

// ACCOUNT SYSTEM
function handleRegister(e) {
    e.preventDefault();
    const user = document.getElementById('reg-username').value.trim();
    const pass = document.getElementById('reg-password').value;
    
    let users = JSON.parse(localStorage.getItem('moonai_users')) || [];
    if(users.some(u => u.username.toLowerCase() === user.toLowerCase())) {
        alert('Benutzername existiert bereits!');
        return;
    }

    users.push({ username: user, password: pass });
    localStorage.setItem('moonai_users', JSON.stringify(users));
    alert('Registrierung erfolgreich! Bitte einloggen.');
    registerForm.reset();
    document.getElementById('to-login').click();
}

function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-username').value.trim();
    const pass = document.getElementById('login-password').value;

    let users = JSON.parse(localStorage.getItem('moonai_users')) || [];
    const foundUser = users.find(u => u.username.toLowerCase() === user.toLowerCase() && u.password === pass);

    if(!foundUser) {
        alert('Ungültige Anmeldedaten!');
        return;
    }

    loginSuccess(foundUser.username);
}

function loginSuccess(username) {
    state.currentUser = username;
    localStorage.setItem('moonai_active_session', username);
    
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    document.getElementById('username-display').innerText = username;
    document.getElementById('user-avatar').innerText = username.substring(0,2).toUpperCase();
    document.getElementById('welcome-username').innerText = username;

    loadUserChats();
}

function checkPersistedAuth() {
    const session = localStorage.getItem('moonai_active_session');
    if(session) { loginSuccess(session); }
}

function logout() {
    localStorage.removeItem('moonai_active_session');
    state.currentUser = null;
    state.chats = [];
    state.currentChatId = null;
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
    loginForm.reset();
}

// CHAT MANAGEMENT
function loadUserChats() {
    const allChats = JSON.parse(localStorage.getItem('moonai_chats')) || [];
    state.chats = allChats.filter(c => c.userId === state.currentUser);
    renderSidebar();
    
    if(state.chats.length > 0) {
        switchChat(state.chats[0].id);
    } else {
        createNewChat(false);
    }
}

function saveChatsToStorage() {
    const allChats = JSON.parse(localStorage.getItem('moonai_chats')) || [];
    const filtered = allChats.filter(c => c.userId !== state.currentUser);
    const updated = [...filtered, ...state.chats];
    localStorage.setItem('moonai_chats', JSON.stringify(updated));
}

function createNewChat(shouldSwitch = true) {
    const newChat = {
        id: 'chat_' + Date.now(),
        userId: state.currentUser,
        title: 'Neuer Chat',
        messages: []
    };
    state.chats.unshift(newChat);
    saveChatsToStorage();
    renderSidebar();
    if(shouldSwitch) switchChat(newChat.id);
}

function switchChat(chatId) {
    state.currentChatId = chatId;
    renderSidebar();
    sidebar.classList.remove('open');
    
    const activeChat = state.chats.find(c => c.id === chatId);
    messagesContainer.innerHTML = '';

    if(!activeChat || activeChat.messages.length === 0) {
        welcomeScreen.classList.remove('hidden');
    } else {
        welcomeScreen.classList.add('hidden');
        activeChat.messages.forEach(msg => {
            appendMessageUI(msg.sender, msg.text);
        });
    }
    scrollToBottom();
}

function deleteChat(chatId, e) {
    e.stopPropagation();
    state.chats = state.chats.filter(c => c.id !== chatId);
    saveChatsToStorage();
    if(state.currentChatId === chatId) {
        state.currentChatId = state.chats.length > 0 ? state.chats[0].id : null;
    }
    loadUserChats();
}

// UI RENDERING
function renderSidebar() {
    chatList.innerHTML = '';
    state.chats.forEach(chat => {
        const li = document.createElement('li');
        li.className = chat.id === state.currentChatId ? 'active' : '';
        li.innerHTML = `
            <div><i class="fa-regular fa-comment-dots" style="margin-right: 8px;"></i> ${chat.title}</div>
            <i class="fa-regular fa-trash-can delete-chat-btn" data-id="${chat.id}"></i>
        `;
        li.addEventListener('click', () => switchChat(chat.id));
        li.querySelector('.delete-chat-btn').addEventListener('click', (e) => deleteChat(chat.id, e));
        chatList.appendChild(li);
    });
}

function appendMessageUI(sender, text) {
    const row = document.createElement('div');
    row.className = `message-row ${sender}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = text.replace(/\n/g, '<br>');
    
    row.appendChild(bubble);
    messagesContainer.appendChild(row);
    scrollToBottom();
}

window.setPresetPrompt = function(text) {
    userInput.value = text;
    handleSendMessage(new Event('submit'));
}

function scrollToBottom() {
    const window = document.getElementById('chat-window');
    window.scrollTop = window.scrollHeight;
}

// SECURE API CALL (Talks to our backend proxy)
async function handleSendMessage(e) {
    if(e) e.preventDefault();
    const prompt = userInput.value.trim();
    if(!prompt) return;

    welcomeScreen.classList.add('hidden');
    appendMessageUI('user', prompt);
    userInput.value = '';
    userInput.style.height = 'auto';

    if(!state.currentChatId) {
        createNewChat(false);
    }
    const currentChat = state.chats.find(c => c.id === state.currentChatId);
    
    if(currentChat.messages.length === 0) {
        currentChat.title = prompt.substring(0, 24) + (prompt.length > 24 ? '...' : '');
    }

    currentChat.messages.push({ sender: 'user', text: prompt });
    saveChatsToStorage();
    renderSidebar();

    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'message-row ai temp-typing';
    typingIndicator.innerHTML = `<div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
    messagesContainer.appendChild(typingIndicator);
    scrollToBottom();

    try {
        const contentsPayload = currentChat.messages.map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text }]
        }));

        // Frontend requests our secure server proxy, passing the structural content payload
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: contentsPayload })
        });

        const data = await response.json();
        
        const tempIndicator = document.querySelector('.temp-typing');
        if(tempIndicator) tempIndicator.remove();

        if (data.candidates && data.candidates[0].content.parts[0].text) {
            const aiResponse = data.candidates[0].content.parts[0].text;
            
            currentChat.messages.push({ sender: 'ai', text: aiResponse });
            saveChatsToStorage();
            appendMessageUI('ai', aiResponse);
        } else {
            throw new Error("Unerwartete API Antwort");
        }

    } catch (error) {
        console.error(error);
        const tempIndicator = document.querySelector('.temp-typing');
        if(tempIndicator) tempIndicator.remove();
        appendMessageUI('ai', "Entschuldigung, beim Verbinden mit den geschützten Moon-Servern ist ein Fehler aufgetreten.");
    }
}