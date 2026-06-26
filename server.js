require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'super-geheimer-fallback-schluessel',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Auf true setzen bei HTTPS
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// In-Memory-Datenbank (wird bei Server-Neustart zurückgesetzt)
const users = [];

// AUTHENTIFIZIERUNG
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Bitte alle Felder ausfüllen.' });
    
    const userExists = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (userExists) return res.status(400).json({ error: 'Nutzername bereits vergeben.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({ username, password: hashedPassword });
        res.json({ success: true, message: 'Registrierung erfolgreich.' });
    } catch (error) {
        res.status(500).json({ error: 'Fehler bei der Registrierung.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });

    try {
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });

        req.session.userId = user.username;
        res.json({ success: true, user: user.username });
    } catch (error) {
        res.status(500).json({ error: 'Fehler beim Login.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Fehler beim Abmelden.' });
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

const checkAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Bitte logge dich zuerst ein.' });
    next();
};

// KI SCHNITTSTELLE
app.post('/api/chat', checkAuth, async (req, res) => {
    const { message, model } = req.body;
    if (!message) return res.status(400).json({ error: 'Keine Nachricht gesendet.' });

    try {
        if (model === 'chatgpt') {
            if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI Key fehlt auf dem Server.' });
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: message }]
                })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            return res.json({ reply: data.choices[0].message.content });
        }
        
        else if (model === 'gemini') {
            if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini Key fehlt auf dem Server.' });
            
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: message }] }] })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            return res.json({ reply: data.candidates[0].content.parts[0].text });
        }
        
        else if (model === 'mistral') {
            if (!process.env.MISTRAL_API_KEY) return res.status(500).json({ error: 'Mistral Key fehlt auf dem Server.' });
            
            const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'mistral-large-latest',
                    messages: [{ role: 'user', content: message }]
                })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            return res.json({ reply: data.choices[0].message.content });
        }

        res.status(400).json({ error: 'Modell nicht unterstützt.' });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Fehler bei der KI-Anfrage.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));
