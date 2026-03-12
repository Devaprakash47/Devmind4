// app.js - IMPROVED with continuous voice + AI recommendations
import { auth, db, initializeAuth, collection, query, limit, Timestamp } from './firebase-config.js';

let currentUser = null;
let isListening = false;
let recognition = null;
let synth = window.speechSynthesis;
let authState = 'initial';
let tempAuth = { email: null, name: null, password: null };
let hasShownWelcome = false;
let currentArticle = null;
let conversationHistory = [];
let authInitialized = false;
let isFirstLoad = true;
let pendingArticles = [];
let awaitingArticleChoice = false;

const msg = document.getElementById('chat-messages');
const inp = document.getElementById('chat-input');
const mic = document.getElementById('btn-voice');
const send = document.getElementById('btn-send');
const logout = document.getElementById('btn-logout');
const uname = document.getElementById('user-name');

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function addMsg(text, isUser = false) {
  const d = document.createElement('div');
  d.className = `message ${isUser ? 'user' : 'assistant'}`;
  d.textContent = ''; // Clear first
  
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  
  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = String(text).replace(/\n/g, '<br>');
  
  d.appendChild(avatar);
  d.appendChild(content);
  msg.appendChild(d);
  msg.scrollTop = msg.scrollHeight;
  
  if (!isUser) speak(text);
}

function typing() {
  const existing = document.getElementById('typing-indicator');
  if (existing) return;
  const d = document.createElement('div');
  d.className = 'message assistant';
  d.id = 'typing-indicator';
  d.innerHTML = '<div class="message-avatar"></div><div class="message-content typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  msg.appendChild(d);
  msg.scrollTop = msg.scrollHeight;
}
function rmTyping() { const t = document.getElementById('typing-indicator'); if (t) t.remove(); }

// SLOW SPEECH - 0.6 rate
function speak(text) {
  if (!synth) return;
  synth.cancel();
  const clean = String(text)
    .replace(/<br>/g, ' ')
    .replace(/[📰📍✅🎉👋📊📌📋📝📄💡🔓❌⚠️🤖🔍💬]/g, '')
    .replace(/\*\*/g, '')
    .replace(/•/g, '');
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 0.7;
  u.pitch = 1.0;
  u.volume = 1.0;
  synth.speak(u);
}

function stopSpeak() { if (synth) synth.cancel(); }

// ========================================
// IMPROVED VOICE RECOGNITION - CONTINUOUS MODE
// ========================================
function initVoiceRecognition() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    console.warn('Speech recognition not supported');
    if (mic) {
      mic.style.opacity = '0.5';
      mic.style.cursor = 'not-allowed';
      mic.title = 'Voice not supported in this browser';
    }
    return;
  }
  
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;
  
  let finalTranscript = '';
  let silenceTimer = null;
  
  recognition.onstart = () => {
    console.log('✅ Voice recognition started');
    isListening = true;
    finalTranscript = '';
    mic.classList.add('recording');
    
    try { 
      mic.querySelector('.mic-icon').style.display = 'none'; 
      mic.querySelector('.stop-icon').style.display = 'block'; 
    } catch (e) {}
    
    const listeningMsg = document.createElement('div');
    listeningMsg.id = 'listeningIndicator';
    listeningMsg.className = 'message assistant';
    listeningMsg.innerHTML = '<div class="message-avatar"></div><div class="message-content">🎤 <strong>Listening...</strong> Speak now!</div>';
    msg.appendChild(listeningMsg);
    msg.scrollTop = msg.scrollHeight;
    
    // Auto-stop after 15 seconds
    silenceTimer = setTimeout(() => {
      console.log('⏰ 15 second timeout - stopping');
      if (recognition && isListening) {
        recognition.stop();
      }
    }, 15000);
  };
  
  recognition.onresult = (event) => {
    console.log('📝 Got speech result');
    
    if (silenceTimer) {
      clearTimeout(silenceTimer);
    }
    
    let interimTranscript = '';
    
    for (let i = 0; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript + ' ';
        console.log('✅ Final:', transcript);
      } else {
        interimTranscript += transcript;
        console.log('⏳ Interim:', transcript);
      }
    }
    
    // Show in input (for visual feedback only)
    inp.value = (finalTranscript + interimTranscript).trim();
    
    // Set timer for silence detection (2 seconds)
    silenceTimer = setTimeout(() => {
      console.log('🛑 Silence detected - stopping');
      if (recognition && isListening) {
        recognition.stop();
      }
    }, 2000);
  };
  
  recognition.onerror = (event) => {
    console.error('❌ Speech recognition error:', event.error);
    
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    
    isListening = false;
    mic.classList.remove('recording');
    try { 
      mic.querySelector('.mic-icon').style.display = 'block'; 
      mic.querySelector('.stop-icon').style.display = 'none'; 
    } catch (e) {}
    
    const indicator = document.getElementById('listeningIndicator');
    if (indicator) indicator.remove();
    
    if (event.error === 'aborted') return;
    
    let errorMsg = 'Voice error. Please try again.';
    
    if (event.error === 'no-speech') {
      errorMsg = '🎤 No speech detected. Press Ctrl+M and speak immediately.';
    } else if (event.error === 'not-allowed') {
      errorMsg = '⚠️ Microphone blocked. Allow in browser settings.';
    } else if (event.error === 'network') {
      errorMsg = '🌐 Network error. Check connection.';
    } else if (event.error === 'audio-capture') {
      errorMsg = '🎤 No microphone found.';
    }
    
    addMsg(errorMsg, false);
  };
  
  recognition.onend = () => {
    console.log('🛑 Voice recognition ended');
    
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    
    isListening = false;
    mic.classList.remove('recording');
    try { 
      mic.querySelector('.mic-icon').style.display = 'block'; 
      mic.querySelector('.stop-icon').style.display = 'none'; 
    } catch (e) {}
    
    const indicator = document.getElementById('listeningIndicator');
    if (indicator) indicator.remove();
    
    // Process voice input
    const voiceText = finalTranscript.trim();
    if (voiceText) {
      console.log('🎤 Processing voice:', voiceText);
      
      // Clear input field
      inp.value = '';
      inp.style.height = 'auto';
      
      // Add user message
      addMsg(voiceText, true);
      
      // Process message
      setTimeout(async () => {
        stopSpeak();
        if (authState === 'authenticated') {
          await handleNews(voiceText);
        } else {
          await handleAuth(voiceText);
        }
      }, 200);
    }
  };
  
  console.log('✅ Voice recognition initialized successfully');
}

function toggleVoiceInput() {
  console.log('🎤 Microphone button clicked, recognition:', recognition);
  
  // Stop any ongoing speech when mic is activated
  stopSpeak();
  
  if (!recognition) {
    console.error('❌ Recognition not initialized');
    const errorMsg = '⚠️ Voice not supported. Use Chrome, Edge, or Safari.';
    addMsg(errorMsg, false);
    return;
  }
  
  if (isListening) {
    console.log('⏹️ Stopping voice recognition');
    recognition.stop();
  } else {
    console.log('▶️ Starting voice recognition');
    try {
      recognition.start();
    } catch (error) {
      console.error('❌ Error starting recognition:', error);
      addMsg('Error starting voice. Please try again.', false);
    }
  }
}

// ========================================
// AI RECOMMENDATIONS BASED ON CONVERSATION
// ========================================
function analyzeConversationAndRecommend() {
  if (conversationHistory.length === 0) return null;
  
  // Get topics from conversation
  const topics = new Set();
  const keywords = new Set();
  
  conversationHistory.forEach(msg => {
    const text = msg.toLowerCase();
    
    // Extract topics
    if (text.includes('cricket')) topics.add('cricket');
    if (text.includes('technology') || text.includes('tech')) topics.add('technology');
    if (text.includes('business') || text.includes('finance')) topics.add('business');
    if (text.includes('sports')) topics.add('sports');
    if (text.includes('politics')) topics.add('politics');
    if (text.includes('health')) topics.add('health');
    if (text.includes('science')) topics.add('science');
    if (text.includes('entertainment')) topics.add('entertainment');
    
    // Extract action keywords
    if (text.includes('explain')) keywords.add('explain');
    if (text.includes('detail')) keywords.add('detail');
    if (text.includes('search')) keywords.add('search');
    if (text.includes('brief')) keywords.add('brief');
  });
  
  // Generate smart recommendations
  const recommendations = [];
  
  if (topics.size > 0) {
    const topicArray = Array.from(topics);
    const mainTopic = topicArray[0];
    
    // Topic-based recommendations
    recommendations.push(`📰 More ${mainTopic} news`);
    recommendations.push(`🔍 Search ${mainTopic} latest updates`);
    
    // Cross-topic recommendations
    if (topics.has('technology') && topics.has('business')) {
      recommendations.push(`💼 Tech business news`);
    }
    if (topics.has('cricket') && topics.has('sports')) {
      recommendations.push(`🏆 Other sports updates`);
    }
  }
  
  // Action-based recommendations
  if (keywords.has('detail') && currentArticle) {
    recommendations.push(`📋 Explain the heading`);
  }
  if (keywords.has('brief') && currentArticle) {
    recommendations.push(`📄 Explain in detail`);
  }
  if (currentArticle) {
    recommendations.push(`🔎 Search content in article`);
  }
  
  // Default recommendations
  if (recommendations.length === 0) {
    recommendations.push(`📰 Cricket news`);
    recommendations.push(`💻 Technology news`);
    recommendations.push(`📈 Business news`);
  }
  
  return recommendations.slice(0, 3); // Top 3 recommendations
}

function showRecommendations() {
  const recommendations = analyzeConversationAndRecommend();
  if (!recommendations || recommendations.length === 0) return '';
  
  const recText = `\n\n💡 **You might also like:**\n${recommendations.map(r => `• ${r}`).join('\n')}`;
  return recText;
}

// ========================================
// MESSAGING FUNCTIONS
// ========================================
async function searchNews(query) {
  // Track conversation
  conversationHistory.push(query);
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20); // Keep last 20
  }
  
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'searchNews', query }, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (response?.success) resolve(response.results);
      else reject(new Error(response?.error || 'Failed'));
    });
  });
}

async function processWebpage(userQuery) {
  // Track conversation
  conversationHistory.push(userQuery);
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20);
  }
  
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'processWebpage', userQuery }, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (response?.success) resolve(response);
      else reject(new Error(response?.error || 'Failed'));
    });
  });
}

async function saveConv(userMsg, botMsg, article = null) {
  if (!currentUser) return;
  try {
    const data = {
      userId: currentUser.uid,
      userName: currentUser.name,
      userEmail: currentUser.email,
      userMessage: userMsg,
      botResponse: botMsg,
      timestamp: Timestamp().now()
    };
    if (article) {
      data.articleTitle = article.title;
      data.articleUrl = article.url;
    }
    await db.addDoc(collection(db, `users/${currentUser.uid}/conversations`), data);
  } catch (e) { console.warn('saveConv failed', e); }
}

async function handleAuth(message) {
  const m = message.toLowerCase().trim();
  console.log('🔐 handleAuth called, authState:', authState, 'message:', m);
  
  switch(authState) {
    case 'waiting_login_choice':
      if (m.includes('yes')) { addMsg("📧 Email?", false); authState = 'waiting_email'; }
      else if (m.includes('no')) { addMsg("📝 Email?", false); authState = 'waiting_register_email'; }
      else { addMsg("Please reply 'yes' or 'no'", false); }
      break;
    case 'waiting_email':
      if (!validEmail(message)) { addMsg("❌ Invalid email.", false); return; }
      tempAuth.email = message; addMsg("🔒 Password?", false); authState = 'waiting_password';
      break;
    case 'waiting_password':
      tempAuth.password = message; typing();
      try { 
        const result = await auth.login(tempAuth.email, tempAuth.password); 
        rmTyping();
        
        if (result && result.user) {
          currentUser = result.user;
          uname.textContent = currentUser.name;
          authState = 'authenticated';
          
          typing();
          const recommendations = await getPersonalizedRecommendations();
          rmTyping();
          
          const greeting = "🎉 **Welcome back, " + currentUser.name + "!**\n\nGreat to see you again.\n\n🔥 **Your top interests:**\n" + recommendations.map(r => '• ' + r).join('\n') + "\n\n🎤 Use voice or type to get started!";
          addMsg(greeting, false);
          hasShownWelcome = true;
        }
      }
      catch (e) { rmTyping(); if ((e.code || '').includes('user-not-found')) { addMsg("❌ Not found. Create? 'yes'/'no'", false); authState = 'email_not_found'; } else { addMsg("❌ Wrong password.", false); tempAuth.password = null; } }
      break;
    case 'email_not_found':
      if (m.includes('yes')) { addMsg("👤 Name?", false); authState = 'waiting_register_name'; }
      else { addMsg("📧 Email?", false); authState = 'waiting_email'; tempAuth.email = null; }
      break;
    case 'waiting_register_email':
      if (!validEmail(message)) { addMsg("❌ Invalid email.", false); return; }
      tempAuth.email = message; addMsg("👤 Name?", false); authState = 'waiting_register_name';
      break;
    case 'waiting_register_name':
      if (message.trim().length < 2) { addMsg("❌ Too short.", false); return; }
      tempAuth.name = message.trim(); addMsg("👋 " + tempAuth.name + "! Password (6+)?", false); authState = 'waiting_register_password';
      break;
    case 'waiting_register_password':
      if (message.length < 6) { addMsg("❌ 6+ chars.", false); return; }
      tempAuth.password = message; typing();
      try { 
        await auth.register(tempAuth.email, tempAuth.password, tempAuth.name); 
        rmTyping();
        hasShownWelcome = false;
      }
      catch (e) { rmTyping(); if ((e.code || '').includes('email-already')) { addMsg("❌ Exists. Login?", false); authState = 'email_exists'; } else { addMsg("❌ Failed.", false); } }
      break;
    case 'email_exists':
      if (m.includes('yes')) { addMsg("🔒 Password?", false); authState = 'waiting_password'; }
      else { addMsg("📧 Different email?", false); authState = 'waiting_register_email'; tempAuth.email = null; }
      break;
    default:
      console.warn('⚠️ Unknown authState:', authState);
      addMsg("Please reply 'yes' or 'no'", false);
      authState = 'waiting_login_choice';
      break;
  }
}

async function openAndProcessArticle(article, originalQuery) {
  currentArticle = { title: article.title, url: article.link };
  
  addMsg(`📰 **${article.title}**\n\n📍 ${article.source?.name || 'Source'}\n\n🔓 Opening...`, false);
  
  chrome.runtime.sendMessage({ action: 'openWebsite', url: article.link }, async (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      addMsg('❌ Failed to open.', false);
      return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    typing();
    try {
      const result = await processWebpage('explain briefly');
      rmTyping();
      
      const recommendations = showRecommendations();
      const fullResponse = `${result.response}${recommendations}\n\n💬 **Ask me:**\n• "explain in detail"\n• "search [keyword]"`;
      
      addMsg(fullResponse, false);
      await saveConv(originalQuery, fullResponse, currentArticle);
    } catch (error) {
      rmTyping();
      addMsg(`✅ Article opened!\n\n💬 Try: "explain the heading" or "explain in detail"`, false);
    }
  });
}

async function handleNews(message) {
  const msgLower = message.toLowerCase().trim();
  
  // Check if user is choosing an article
  if (awaitingArticleChoice) {
    // Convert word numbers to digits
    const wordToNum = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5 };
    let choice = parseInt(message);
    
    // If not a number, check if it's a word
    if (isNaN(choice)) {
      choice = wordToNum[msgLower];
    }
    
    if (choice >= 1 && choice <= pendingArticles.length) {
      const article = pendingArticles[choice - 1];
      awaitingArticleChoice = false;
      pendingArticles = [];
      await openAndProcessArticle(article, message);
      return;
    } else {
      addMsg("Invalid choice. Say a number from 1 to " + pendingArticles.length, false);
      return;
    }
  }
  
  if (currentArticle) {
    const isCommand = msgLower.includes('explain') || msgLower.includes('heading') || 
                     msgLower.includes('brief') || msgLower.includes('detail') || 
                     msgLower.includes('search') || msgLower.includes('find') || 
                     msgLower.includes('what is this') || msgLower.includes('about');
    if (isCommand) {
      typing();
      try {
        const result = await processWebpage(message);
        rmTyping();
        
        const recommendations = showRecommendations();
        const response = `${result.response}${recommendations}\n\n💬 **Ask me:** "explain in detail" or "search [keyword]"`;
        
        addMsg(response, false);
        await saveConv(message, response, currentArticle);
        return;
      } catch (error) {
        rmTyping(); 
        console.error('Command error:', error); 
        addMsg('❌ Could not process. Try: "explain briefly" or "explain in detail"', false); 
        return;
      }
    }
  }
  
  typing();
  try {
    const results = await searchNews(message);
    rmTyping();
    
    if (!results || results.length === 0) {
      const suggestions = ['cricket news', 'technology news', 'business news', 'politics news'];
      addMsg(`❌ No results for "${message}".\n\n💡 Try: ${suggestions.filter(s => !message.toLowerCase().includes(s.split(' ')[0])).slice(0, 2).join(' or ')}`, false);
      return;
    }
    
    // Show top 5 articles
    pendingArticles = results.slice(0, 5);
    awaitingArticleChoice = true;
    
    let articleList = `📰 **Found ${results.length} articles**\n\n`;
    pendingArticles.forEach((article, i) => {
      articleList += `<span class="article-number">${i + 1}</span><span class="article-title">${article.title}</span>\n<span class="article-source">📍 ${article.source?.name || 'Source'}</span>\n\n`;
    });
    articleList += `<div class="choice-prompt">👉 Reply with 1-5 to open article</div>`;
    
    addMsg(articleList, false);
  } catch (error) {
    rmTyping();
    addMsg('❌ Search failed. Check your connection and try again.', false);
  }
}

async function sendMsg() {
  const message = inp.value.trim();
  if (!message) return;
  inp.value = '';
  inp.style.height = 'auto';
  stopSpeak();
  
  addMsg(message, true);
  
  if (authState === 'authenticated') await handleNews(message);
  else await handleAuth(message);
}

async function doLogout() {
  try {
    await auth.signOut();
    msg.innerHTML = '';
    conversationHistory = [];
    authState = 'waiting_login_choice';
    tempAuth = { email: null, name: null, password: null };
    hasShownWelcome = false;
    currentArticle = null;
    isFirstLoad = true;
    pendingArticles = [];
    awaitingArticleChoice = false;
    addMsg("👋 Logged out successfully. See you soon!", false);
  } catch (e) {}
}

// EVENT LISTENERS
if (mic) mic.addEventListener('click', toggleVoiceInput);
if (send) send.addEventListener('click', sendMsg);
if (logout) logout.addEventListener('click', doLogout);
if (inp) {
  inp.addEventListener('keypress', e => { 
    if (e.key === 'Enter' && !e.shiftKey) { 
      e.preventDefault(); 
      sendMsg(); 
    } 
  });
  inp.addEventListener('input', function() { 
    this.style.height = 'auto'; 
    this.style.height = Math.min(this.scrollHeight, 120) + 'px'; 
  });
}

// KEYBOARD SHORTCUTS
document.addEventListener('keydown', (e) => {
  // Ctrl+M or Space to START microphone
  if ((e.ctrlKey && e.key === 'm') || (e.code === 'Space' && document.activeElement !== inp)) {
    e.preventDefault();
    
    if (!isListening && recognition) {
      stopSpeak();
      try {
        recognition.start();
      } catch (error) {
        console.error('Error starting recognition:', error);
      }
    }
  }
  
  // Ctrl+S to STOP microphone
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    
    if (isListening && recognition) {
      recognition.stop();
    }
  }
  
  // Escape to STOP speech
  if (e.key === 'Escape') {
    e.preventDefault();
    stopSpeak();
  }
});

// RIGHT-CLICK to START microphone
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  
  if (!isListening && recognition) {
    stopSpeak();
    try {
      recognition.start();
    } catch (error) {
      console.error('Error starting recognition:', error);
    }
  }
});

async function getPersonalizedRecommendations() {
  if (!currentUser) return [];
  
  try {
    const convQuery = query(collection(db, `users/${currentUser.uid}/conversations`), limit(15));
    const snapshot = await db.getDocs(convQuery);
    
    if (snapshot.empty) return [];
    
    const topics = new Map();
    const recentQueries = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const text = (data.userMessage + ' ' + data.botResponse).toLowerCase();
      recentQueries.push(data.userMessage);
      
      if (/(cricket|ipl|t20|test|odi|match|score)/i.test(text)) topics.set('cricket', (topics.get('cricket') || 0) + 1);
      if (/(tech|ai|software|app|computer|coding)/i.test(text)) topics.set('technology', (topics.get('technology') || 0) + 1);
      if (/(business|stock|market|economy|company|finance)/i.test(text)) topics.set('business', (topics.get('business') || 0) + 1);
      if (/(politics|election|government|minister|president)/i.test(text)) topics.set('politics', (topics.get('politics') || 0) + 1);
      if (/(health|medical|disease|doctor|covid)/i.test(text)) topics.set('health', (topics.get('health') || 0) + 1);
      if (/(entertainment|movie|music|celebrity|film)/i.test(text)) topics.set('entertainment', (topics.get('entertainment') || 0) + 1);
      if (/(sports|football|tennis|basketball)/i.test(text)) topics.set('sports', (topics.get('sports') || 0) + 1);
    });
    
    const sorted = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const recs = sorted.map(([topic]) => {
      const icons = {
        cricket: '🏏',
        technology: '💻',
        business: '💼',
        politics: '🏛️',
        health: '⚕️',
        entertainment: '🎬',
        sports: '⚽'
      };
      return `${icons[topic] || '📰'} ${topic} news`;
    });
    
    return recs.length > 0 ? recs : ['🏏 cricket news', '💻 technology news', '💼 business news'];
  } catch (e) {
    console.error('Recommendation error:', e);
    return ['🏏 cricket news', '💻 technology news', '💼 business news'];
  }
}

auth.onAuthStateChanged(async user => {
  console.log('🔔 Auth state changed:', user ? user.name : 'Guest', 'isFirstLoad:', isFirstLoad, 'hasShownWelcome:', hasShownWelcome, 'authState:', authState);
  
  if (!isFirstLoad) {
    if (user && authState !== 'authenticated') {
      currentUser = user; 
      uname.textContent = user.name; 
      authState = 'authenticated';
      
      if (!hasShownWelcome) {
        typing();
        const recommendations = await getPersonalizedRecommendations();
        rmTyping();
        
        const greeting = "🎉 **Welcome back, " + user.name + "!**\n\nGreat to see you again. I've analyzed your conversation history and prepared personalized recommendations.\n\n🔥 **Your top interests:**\n" + recommendations.map(r => '• ' + r).join('\n') + "\n\n🎤 Use voice or type to get started!";
        addMsg(greeting, false);
        hasShownWelcome = true;
      }
    } else if (!user && authState === 'authenticated') {
      currentUser = null;
      uname.textContent = 'Guest';
      authState = 'waiting_login_choice';
      hasShownWelcome = false;
    }
  }
});

// INITIALIZE
(async () => {
  console.log('🔄 Initializing WebMind...');
  
  // Wait for auth to fully load from storage FIRST
  console.log('🔐 Checking authentication...');
  const loadedUser = await initializeAuth();
  console.log('👤 Loaded user:', loadedUser);
  
  // Update currentUser from auth module
  if (loadedUser) {
    currentUser = loadedUser;
    authState = 'authenticated';
    uname.textContent = currentUser.name;
  }
  
  // Small delay to ensure DOM is ready
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log('👤 Current user after init:', currentUser);
  console.log('🚩 hasShownWelcome:', hasShownWelcome);
  
  // Show welcome based on auth state
  if (currentUser) {
    console.log('✅ Showing logged-in welcome...');
    typing();
    const recommendations = await getPersonalizedRecommendations();
    rmTyping();
    
    const greeting = `🎉 **Welcome back, ${currentUser.name}!**\n\nGreat to see you again. I've analyzed your conversation history and prepared personalized recommendations.\n\n🔥 **Your top interests:**\n${recommendations.map(r => `• ${r}`).join('\n')}\n\n🎤 Use voice or type to get started!`;
    addMsg(greeting, false);
  } else {
    console.log('✅ Showing guest welcome...');
    authState = 'waiting_login_choice';
    addMsg("👋 **Welcome to WebMind!**\n\nAccount? 'yes' or 'no'", false);
  }
  
  hasShownWelcome = true;
  isFirstLoad = false;
  
  // Initialize voice AFTER welcome
  initVoiceRecognition();
  
  console.log('✅ WebMind v29.0 - Voice Shortcuts + Auto Speech Stop');
  console.log('🎤 Mic Start: Ctrl+M, Space, Right-click');
  console.log('🛑 Mic Stop: Ctrl+S');
  console.log('🔇 Speech Stop: Escape');
})();