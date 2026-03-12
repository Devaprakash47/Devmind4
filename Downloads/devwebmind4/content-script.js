// content-script.js (updated extraction)
// Returns: { title, sentences: [...], keywords: [...], url, description }

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractContent') {
    try {
      const content = extractPageContent();
      sendResponse({ success: true, content });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
});

function extractPageContent() {
  // Elements to ignore
  const unwantedSelectors = ['script', 'style', 'nav', 'footer', 'aside', '.ad', '.advertisement', '.sidebar', '.social', '.comments', 'iframe', 'form'];

  // Candidate main containers
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.querySelector('.article-content'),
    document.querySelector('.content'),
    document.body
  ].filter(el => el);

  let best = document.body;
  let maxScore = 0;
  for (const c of candidates) {
    const text = (c.textContent || '').trim();
    const paras = c.querySelectorAll('p').length;
    const score = text.length / 100 + paras * 12;
    if (score > maxScore) { maxScore = score; best = c; }
  }

  // Title and meta description
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                document.querySelector('h1')?.textContent?.trim() ||
                document.querySelector('title')?.textContent?.trim() ||
                document.location.hostname;

  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ||
                      document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';

  const url = location.href;

  // Gather paragraphs (filter short ones)
  const paragraphs = Array.from(best.querySelectorAll('p'))
    .map(p => p.textContent.trim())
    .filter(t => t && t.length >= 40 && t.split(' ').length >= 5);

  // Split paragraphs into sentences carefully
  const sentences = [];
  for (const para of paragraphs) {
    const sents = para
      .replace(/Dr\./g, 'Dr<dot>')
      .replace(/Mr\./g, 'Mr<dot>')
      .replace(/Mrs\./g, 'Mrs<dot>')
      .replace(/vs\./g, 'vs<dot>')
      .split(/[.!?]+\s+/)
      .map(s => s.replace(/<dot>/g, '.').trim())
      .filter(s => s.length >= 20);
    sentences.push(...sents);
  }

  // Extract keywords (simple freq-based)
  const keywords = extractKeywords(sentences.join(' '));

  return { title, description, url, sentences, keywords };
}

function extractKeywords(text) {
  const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
    'in', 'with', 'to', 'for', 'of', 'as', 'by', 'that', 'this', 'it', 'from', 'they', 'we',
    'are', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'was', 'were', 'am', 'i', 'you', 'he', 'she', 'them']);
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);
}

console.log('✅ Content script (enhanced) loaded');
