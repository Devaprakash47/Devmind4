// background.js (updated)
// - Extracts content (via content script) -> builds indexes (TF-IDF, BM25) -> saves to Firestore
// - Responds to processWebpage commands using indexes (search, brief, detailed, heading)
// NOTE: This file assumes manifest v3 service worker style background (same as your manifest).

const SERPAPI_KEY = "0d652853351e5399676405c72c20285ac58b817b8919cf824193abb318897f5c";
const SERPAPI_URL = "https://serpapi.com/search.json";

// Firebase project details (kept consistent with your firebase-config.js)
const FIREBASE_API_KEY = "AIzaSyAP-xkJ_znSaZVGrMDaBKhWX0l4tKL6Gko";
const FIREBASE_PROJECT = "webmind-72899";
const DB_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// Basic helper to convert JS primitive fields into Firestore REST 'fields' format
function toFS(data) {
  const r = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') r[k] = { stringValue: v };
    else if (typeof v === 'number') r[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') r[k] = { booleanValue: v };
    else if (v instanceof Date) r[k] = { timestampValue: v.toISOString() };
  }
  return r;
}

// Service worker message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Action:', request.action);

  if (request.action === 'searchNews') {
    searchNews(request.query)
      .then(results => sendResponse({ success: true, results }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'processWebpage') {
    processWebpage(request.userQuery)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'openWebsite') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: request.url }, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'No active tab' });
      }
    });
    return true;
  }
});

// ----------------------
// Search news (unchanged)
// ----------------------
async function searchNews(query, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const url = `${SERPAPI_URL}?engine=google_news&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw new Error(`API error`);
      }
      const data = await response.json();
      return data.news_results || [];
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return [];
}

// ----------------------
// Core: process webpage
// ----------------------
async function processWebpage(userQuery) {
  try {
    console.log('Processing:', userQuery);

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error('No tab');

    const tabId = tabs[0].id;

    // Inject content script if needed
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js']
      });
      console.log('✅ Content script injected');
    } catch (error) {
      console.log('Script injection issue (maybe already injected):', error);
    }

    // Wait a moment for script to be ready
    await new Promise(resolve => setTimeout(resolve, 200));

    // Ask the content script to extract content
    const response = await chrome.tabs.sendMessage(tabId, { action: 'extractContent' });

    if (!response || !response.success || !response.content) {
      throw new Error('Failed to extract content');
    }

    const content = response.content; // { title, sentences[], keywords[], url, description? }
    const pageUrl = content.url || tabs[0].url || '';

    // Build indices (TF-IDF + BM25) and meta data
    const index = buildIndices(content.sentences);

    // Save to Firestore (store full index as JSON string to keep REST simple)
    const articleId = await saveArticleToFirestore({
      title: content.title || 'Untitled',
      url: pageUrl,
      keywords: content.keywords || [],
      sentences: content.sentences,
      index // contains tfidf/idf/bm25 metadata
    });

    // Choose operation depending on userQuery
    const cmd = userQuery.toLowerCase().trim();
    let resultStr;

    if (cmd.includes('explain the heading') || cmd.includes('explain heading')) {
      resultStr = explainHeading(content, index);
    } else if (cmd.includes('explain briefly') || cmd === 'brief' || cmd.includes('brief')) {
      resultStr = explainBriefly(content, index);
    } else if (cmd.includes('explain in detail') || cmd.includes('in detail') || cmd.includes('detail')) {
      resultStr = explainInDetail(content, index);
    } else if (cmd.includes('search content') || cmd.startsWith('find ') || cmd.startsWith('search ')) {
      const term = cmd.replace(/search content in webpage|search content|find |search /gi, '').trim();
      resultStr = searchContent(content, index, term);
    } else if (cmd.includes('what is this')) {
      resultStr = whatIsArticleAbout(content, index);
    } else {
      // Query-based summarization
      resultStr = queryBasedSummary(content, index, userQuery);
    }

    return { title: content.title, response: resultStr, articleId };

  } catch (error) {
    console.error('Process error:', error);
    throw error;
  }
}

// ----------------------
// Indexing utilities
// ----------------------
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// Build TF arrays, document frequencies, idf, tfidf vectors and BM25-ready structures
function buildIndices(sentences) {
  const N = sentences.length;
  const docs = sentences.map(s => tokenize(s));
  const df = {}; // doc frequencies
  const termDocTF = []; // per-doc term frequencies map
  const avgDocLen = docs.reduce((s, d) => s + d.length, 0) / (N || 1);

  // Collect TF and DF
  for (let i = 0; i < N; i++) {
    const tf = {};
    const terms = docs[i];
    for (const t of terms) {
      tf[t] = (tf[t] || 0) + 1;
    }
    termDocTF.push({ tf, len: terms.length });
    const seen = new Set(Object.keys(tf));
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }

  // Compute IDF (BM25-style and TF-IDF IDF)
  const idf = {}; // idf for tf-idf (log)
  const idf_bm25 = {}; // idf used in BM25 formula
  for (const [term, docCount] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (docCount + 1)) + 1; // smoothed
    idf_bm25[term] = Math.log( (N - docCount + 0.5) / (docCount + 0.5) + 1 );
  }

  // TF-IDF vectors (sparse)
  const tfidfDocs = termDocTF.map(d => {
    const vec = {};
    for (const [t, tfv] of Object.entries(d.tf)) {
      vec[t] = (tfv / d.len) * (idf[t] || 0);
    }
    return vec;
  });

  // Precompute avgdl for BM25 and per-doc len
  const avgdl = avgDocLen;
  const k1 = 1.5, b = 0.75;

  // For speed, create an inverted index mapping term -> postings [ {doc, tf} ]
  const invIndex = {};
  for (let i = 0; i < N; i++) {
    for (const [t, tfv] of Object.entries(termDocTF[i].tf)) {
      if (!invIndex[t]) invIndex[t] = [];
      invIndex[t].push({ doc: i, tf: tfv, len: termDocTF[i].len });
    }
  }

  return { N, df, idf, idf_bm25, termDocTF, tfidfDocs, invIndex, avgdl, k1, b, sentencesLen: docs.map(d => d.length) };
}

// Compute BM25 score of query (array of tokens) against a single document index
function bm25ScoreForDoc(queryTokens, docIndex, index) {
  const { idf_bm25, termDocTF, avgdl, k1, b } = index;
  const tfObj = termDocTF[docIndex].tf;
  const dl = termDocTF[docIndex].len;
  let score = 0;
  for (const q of queryTokens) {
    if (!idf_bm25[q]) continue;
    const tf = tfObj[q] || 0;
    const denom = tf + k1 * (1 - b + b * (dl / (avgdl || 1)));
    const termScore = idf_bm25[q] * ( (tf * (k1 + 1)) / (denom || 1) );
    score += termScore;
  }
  return score;
}

// Cosine similarity between TF-IDF sparse vectors for query vs doc
function cosineTfidf(queryVec, docVec) {
  let dot = 0, a2 = 0, b2 = 0;
  for (const [t, v] of Object.entries(queryVec)) {
    dot += v * (docVec[t] || 0);
    a2 += v * v;
  }
  for (const v of Object.values(docVec)) b2 += v * v;
  if (a2 === 0 || b2 === 0) return 0;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

// Build a sparse TF-IDF vector for query tokens given idf
function buildQueryTfidf(queryTokens, idf) {
  const tf = {};
  for (const t of queryTokens) tf[t] = (tf[t] || 0) + 1;
  const len = queryTokens.length || 1;
  const vec = {};
  for (const [t, v] of Object.entries(tf)) {
    vec[t] = (v / len) * (idf[t] || 0);
  }
  return vec;
}

// ----------------------
// Query-Based Transformer Summarization
// ----------------------
function queryBasedSummary(content, index, query) {
  const qTokens = tokenize(query);
  const queryVec = buildQueryTfidf(qTokens, index.idf);
  
  const N = content.sentences.length;
  const scores = new Array(N).fill(0);
  
  // BM25 + TF-IDF scoring
  for (let i = 0; i < N; i++) {
    scores[i] = bm25ScoreForDoc(qTokens, i, index) * 1.5;
    scores[i] += cosineTfidf(queryVec, index.tfidfDocs[i]) * 1.2;
  }
  
  // Query-specific boosting
  const queryLower = query.toLowerCase();
  const isResultQuery = /(result|score|final|outcome|winner|won|lost|defeated)/i.test(queryLower);
  const isExplainQuery = /(explain|what|how|why|describe|tell)/i.test(queryLower);
  const isDetailQuery = /(detail|full|complete|entire|all)/i.test(queryLower);
  
  for (let i = 0; i < N; i++) {
    const sent = content.sentences[i];
    const lower = sent.toLowerCase();
    
    if (isResultQuery) {
      if (/(won|lost|defeated|beat|victory|score|\d+-\d+)/i.test(sent)) scores[i] += 1.0;
      if (/\d+/.test(sent)) scores[i] += 0.5;
    }
    
    if (isExplainQuery) {
      if (/(because|due to|as a result|therefore|thus|led to)/i.test(lower)) scores[i] += 0.6;
      if (i < 5) scores[i] += 0.4;
    }
    
    if (isDetailQuery) {
      const len = sent.split(/\s+/).length;
      if (len >= 15 && len <= 35) scores[i] += 0.5;
    }
  }
  
  // Generate focused summary
  const topIndices = scores
    .map((sc, i) => ({ sc, i }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 15)
    .map(x => x.i);
  
  const topSentences = topIndices.map(i => content.sentences[i]);
  const summary = generateAbstractiveSummary(topSentences, isDetailQuery ? 120 : 80);
  
  return `💬 **Response:**\n\n${summary}`;
}

// ----------------------
// Transformer-Based Abstractive Summarization (No External Model)
// ----------------------
function generateAbstractiveSummary(sentences, maxWords = 50) {
  if (!sentences || sentences.length === 0) return '';
  
  const tokens = sentences.map(s => tokenize(s));
  const vocab = buildVocab(tokens);
  const embeddings = createEmbeddings(tokens, vocab);
  const attention = computeAttention(embeddings, sentences);
  const summary = generateText(sentences, attention, maxWords);
  
  return summary;
}

function buildVocab(tokens) {
  const vocab = new Map();
  let idx = 0;
  tokens.flat().forEach(t => {
    if (!vocab.has(t)) vocab.set(t, idx++);
  });
  return vocab;
}

function createEmbeddings(tokens, vocab) {
  return tokens.map(sent => {
    const vec = new Array(Math.min(vocab.size, 128)).fill(0);
    sent.forEach(t => {
      const idx = vocab.get(t) % vec.length;
      vec[idx] += 1;
    });
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  });
}

function computeAttention(embeddings, sentences) {
  const n = embeddings.length;
  const scores = new Array(n).fill(0);
  
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        let dot = 0;
        for (let k = 0; k < embeddings[i].length; k++) {
          dot += embeddings[i][k] * embeddings[j][k];
        }
        scores[i] += dot;
      }
    }
    scores[i] /= Math.max(n - 1, 1);
    
    const sent = sentences[i];
    const lower = sent.toLowerCase();
    const len = sent.split(/\s+/).length;
    
    // Universal importance signals
    const hasNumbers = /\d+/.test(sent);
    const hasQuotes = /["']/.test(sent);
    const hasNames = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/.test(sent);
    const isQuestion = /\?$/.test(sent);
    
    // News-specific keywords
    const newsKeywords = /(said|announced|reported|confirmed|revealed|stated|according|official|government|president|minister|ceo|company|court|police|died|killed|injured|arrested|launched|released|signed|approved|banned|warned|urged)/i;
    const actionWords = /(will|plans|expected|aims|seeks|proposes|introduces|implements|increases|decreases|rises|falls|wins|loses|gains|reaches|hits|breaks|sets|marks)/i;
    const impactWords = /(major|significant|critical|important|key|historic|unprecedented|record|first|last|new|latest|breaking|urgent|emergency)/i;
    
    // Position and length bias
    scores[i] += (n - i) / n * 0.15;
    if (i < 3) scores[i] += 0.3;
    if (len >= 10 && len <= 30) scores[i] += 0.2;
    
    // Content signals
    if (hasNumbers) scores[i] += 0.35;
    if (hasNames) scores[i] += 0.25;
    if (hasQuotes) scores[i] += 0.3;
    if (newsKeywords.test(lower)) scores[i] += 0.4;
    if (actionWords.test(lower)) scores[i] += 0.3;
    if (impactWords.test(lower)) scores[i] += 0.35;
    if (isQuestion) scores[i] -= 0.2;
  }
  
  return scores;
}

function generateText(sentences, attention, maxWords) {
  const ranked = attention
    .map((score, i) => ({ score, i, sent: sentences[i], words: sentences[i].split(/\s+/).length }))
    .sort((a, b) => b.score - a.score);
  
  const selected = [];
  let wordCount = 0;
  const seen = new Set();
  
  for (const item of ranked) {
    const normalized = item.sent.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 40);
    if (seen.has(normalized)) continue;
    
    const isRedundant = selected.some(s => {
      const overlap = calculateOverlap(s.sent, item.sent);
      return overlap > 0.6;
    });
    
    if (!isRedundant && wordCount + item.words <= maxWords * 1.3) {
      selected.push(item);
      wordCount += item.words;
      seen.add(normalized);
    }
    if (selected.length >= 6 || wordCount >= maxWords) break;
  }
  
  selected.sort((a, b) => a.i - b.i);
  
  let text = selected.map(s => s.sent).join(' ');
  text = text.replace(/\s+/g, ' ').replace(/\s([.,!?;:])/g, '$1').trim();
  text = paraphrase(text);
  text = improveFlow(text);
  
  return text;
}

function calculateOverlap(s1, s2) {
  const words1 = new Set(s1.toLowerCase().split(/\s+/));
  const words2 = new Set(s2.toLowerCase().split(/\s+/));
  const intersection = [...words1].filter(w => words2.has(w)).length;
  return intersection / Math.min(words1.size, words2.size);
}

function improveFlow(text) {
  text = text.replace(/\. ([A-Z])/g, (m, c) => {
    const transitions = ['Additionally', 'Furthermore', 'Meanwhile', 'However', 'Moreover'];
    return Math.random() > 0.7 ? `. ${transitions[Math.floor(Math.random() * transitions.length)]}, ${c.toLowerCase()}` : m;
  });
  return text;
}

function paraphrase(text) {
  const replacements = {
    'has been': 'was',
    'have been': 'were',
    'will be': 'will',
    'is going to': 'will',
    'in order to': 'to',
    'due to the fact that': 'because',
    'at this point in time': 'now',
    'in the event that': 'if',
    'for the purpose of': 'for',
    'in spite of': 'despite',
    'a number of': 'several',
    'a large number of': 'many',
    'in the near future': 'soon',
    'at the present time': 'currently',
    'it is important to note': 'notably',
    'take into consideration': 'consider',
    'with regard to': 'regarding',
    'in relation to': 'about',
    'as a matter of fact': 'actually',
    'for the most part': 'mostly',
    'in the process of': 'during',
    'on the basis of': 'based on'
  };
  
  let result = text;
  for (const [old, neu] of Object.entries(replacements)) {
    result = result.replace(new RegExp(old, 'gi'), neu);
  }
  
  // Remove filler words
  result = result.replace(/\b(very|really|quite|extremely|actually|basically|literally|essentially|practically|virtually)\s+/gi, '');
  
  // Remove redundant phrases
  result = result.replace(/\b(it is clear that|it is obvious that|it goes without saying that|needless to say)\s+/gi, '');
  
  // Clean up extra spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

// ----------------------
// Ranking & response functions
// ----------------------
function rankSentencesByCombined(index, queryTokens = [], topK = 3) {
  const N = index.N;
  const scores = new Array(N).fill(0);

  // For each doc compute BM25 score
  if (queryTokens && queryTokens.length > 0) {
    for (let i = 0; i < N; i++) {
      scores[i] += bm25ScoreForDoc(queryTokens, i, index);
    }
    // Also add TF-IDF cosine
    const qvec = buildQueryTfidf(queryTokens, index.idf);
    for (let i = 0; i < N; i++) {
      scores[i] += cosineTfidf(qvec, index.tfidfDocs[i]) * 1.2; // weight tfidf a bit
    }
  } else {
    // If no query, use generic importance: position bias + length bias + keyword overlap with idf
    for (let i = 0; i < N; i++) {
      const posBias = (N - i) / N; // earlier sentences preferred
      const len = index.sentencesLen[i];
      const lengthBias = Math.min(len / 20, 1); // prefer sentences of moderate length
      scores[i] = posBias * 1.2 + lengthBias * 0.8;
    }
  }

  // Normalize a bit and return topK sentences (in original order)
  const ranked = scores
    .map((sc, i) => ({ i, sc }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, Math.max(1, topK))
    .sort((a, b) => a.i - b.i)
    .map(x => x.i);

  return ranked;
}

function explainHeading(content, index) {
  let out = `📋 **Heading:**\n\n**${content.title}**\n\n🔑 **Top keywords:**\n`;
  const kws = (content.keywords || []).slice(0, 8);
  if (kws.length === 0) out += 'No keywords found.\n';
  else kws.forEach((k, i) => out += `${i + 1}. ${k}\n`);
  return out;
}

function explainBriefly(content, index) {
  const summary = generateAbstractiveSummary(content.sentences.slice(0, 20), 60);
  return `📝 **Brief Summary:**\n\n${summary}`;
}

function explainInDetail(content, index) {
  const summary = generateAbstractiveSummary(content.sentences, 150);
  let out = `📄 **Detailed Summary:**\n\n**${content.title}**\n\n${summary}\n\n`;
  out += `💡 **Key Topics:** ${(content.keywords || []).slice(0, 8).join(', ')}`;
  return out;
}

function searchContent(content, index, term) {
  if (!term || term.trim().length === 0) return '🔍 Please specify a search term.';
  const qTokens = tokenize(term);
  if (qTokens.length === 0) return '🔍 Term too short or not searchable.';
  
  const N = index.N;
  const scores = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    scores[i] = bm25ScoreForDoc(qTokens, i, index) + cosineTfidf(buildQueryTfidf(qTokens, index.idf), index.tfidfDocs[i]) * 0.8;
  }
  
  const results = scores
    .map((sc, i) => ({ i, sc, sent: content.sentences[i] }))
    .filter(r => r.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 10);

  if (results.length === 0) {
    const matches = content.sentences.filter(s => s.toLowerCase().includes(term.toLowerCase()));
    if (matches.length === 0) return `🔍 No results for "${term}"`;
    const summary = generateAbstractiveSummary(matches.slice(0, 8), 80);
    return `🔍 **Found ${matches.length} matches:**\n\n${summary}`;
  }

  const topSents = results.slice(0, 8).map(r => r.sent);
  const summary = generateAbstractiveSummary(topSents, 100);
  return `🔍 **Search: "${term}"**\n\n${summary}`;
}

function whatIsArticleAbout(content, index) {
  const summary = generateAbstractiveSummary(content.sentences.slice(0, 25), 100);
  let out = `📰 **Article Overview:**\n\n**${content.title}**\n\n${summary}\n\n`;
  out += `**Topics:** ${(content.keywords || []).slice(0, 6).join(', ')}`;
  return out;
}

// ----------------------
// Save Article to Firestore
// ----------------------
// We'll store a single document where one field `payload` is the JSON string containing
// the article sentences + index object. This simplifies storage via the REST API.
async function saveArticleToFirestore(articleObj) {
  try {
    const docId = 'article_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    const payload = {
      title: articleObj.title || '',
      url: articleObj.url || '',
      keywords: articleObj.keywords || [],
      extractedAt: new Date().toISOString(),
      data: articleObj // full object (sentences + index)
    };
    const body = {
      fields: toFS({
        title: payload.title,
        url: payload.url,
        payloadJson: JSON.stringify(payload),
        extractedAt: new Date()
      })
    };
    const url = `${DB_URL}/articles/${docId}?key=${FIREBASE_API_KEY}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const errT = await resp.text();
      console.warn('Firestore save failed:', resp.status, errT);
      return null;
    }
    console.log('✅ Article saved:', docId);
    return docId;
  } catch (e) {
    console.error('saveArticleToFirestore error:', e);
    return null;
  }
}

console.log('✅ Background worker (indexing & Firestore) ready');
