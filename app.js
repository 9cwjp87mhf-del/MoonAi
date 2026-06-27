let messages = [];

function sendMessage() {
    const input = document.getElementById('input');
    const text = input.value.trim();
    if (!text) return;

    addMessage('user', text);
    input.value = '';

    // Simulate AI response
    setTimeout(() => {
        addMessage('model', 'Dies ist eine simulierte Antwort von MoonAi.');
    }, 800);
}

function addMessage(role, content) {
    messages.push({role, content});
    const chat = document.getElementById('chat');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = content;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

// PWA install prompt handling etc.
console.log('MoonAi PWA loaded');