require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'SEO-Agent';

const REPOS_DIR = path.join(__dirname, 'repos');
fs.ensureDirSync(REPOS_DIR);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

const jobs = {};

// ──── FOCUSED PROMPT – ONLY HTML FILES, SMALLER CONTEXT ────
function buildGeniusPrompt(repoPath, repoName) {
  const files = [];
  const MAX_FILE_CONTENT_HTML = 12000;
  const MAX_TOTAL_CHARS = 30000;
  let totalChars = 0;

  const walk = (dir) => {
    if (totalChars >= MAX_TOTAL_CHARS) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (totalChars >= MAX_TOTAL_CHARS) break;
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoPath, full);
      if (entry.isDirectory() && !rel.startsWith('.git') && !rel.startsWith('node_modules')) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Only include HTML files – that's where meta and schema go
        if (['.html', '.htm'].includes(ext)) {
          let content = fs.readFileSync(full, 'utf-8');
          if (content.length > MAX_FILE_CONTENT_HTML) {
            content = content.substring(0, MAX_FILE_CONTENT_HTML) + '\n... (truncated) ...';
          }
          files.push({ path: rel, content });
          totalChars += content.length;
        }
      }
    }
  };
  walk(repoPath);
  const fileList = files.map(f => `### FILE: ${f.path} ###\n${f.content}`).join('\n\n');

  return `You are an SEO/AEO expert. Analyse the HTML files below and return ONLY valid JSON.

The repository is "${repoName}". Files:
${fileList}

## INSTRUCTIONS
Return a JSON object with exactly two keys:
1. "strategicReport": a short (max 300 words) analysis with score, gaps, and opportunities.
2. "modifications": an array of objects { "path": "relative/path.html", "content": "full new HTML content" }.

### RULES FOR MODIFICATIONS
- DO NOT change any visible text, images, scripts, styles, or layout.
- ONLY add or improve:
  - <title> and <meta name="description">
  - Open Graph / Twitter Card meta tags
  - canonical, viewport, author, date meta
  - missing alt attributes on images (add descriptive text)
  - fix heading hierarchy (wrap existing text in correct <h1>–<h6> – never change wording)
  - add JSON‑LD schema.org inside <script type="application/ld+json">: at minimum Organization and WebSite, plus any relevant types (Article, FAQ, HowTo, etc.) based on the page content.
- The content must be the original file with ONLY these additions.

Return ONLY the JSON – no markdown, no extra text, no explanation.

Example:
{
  "strategicReport": "Score: 75 (B). …",
  "modifications": [
    {"path": "index.html", "content": "<!DOCTYPE html>…</html>"}
  ]
}`;
}

// ──── Fallback schema generator (if AI fails) ────
function generateBasicSchema(htmlContent, url) {
  const siteName = path.basename(url).replace('.html', '') || 'My Website';
  const org = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": siteName,
    "url": url
  };
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": siteName,
    "url": url
  };
  return `<script type="application/ld+json">${JSON.stringify(org)}</script>\n<script type="application/ld+json">${JSON.stringify(website)}</script>`;
}

// ──── SSE Helpers ────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ──── JSON extraction (robust) ────
function extractJSONObject(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(cleaned.substring(start, end + 1)); }
    catch (e) {}
  }
  return null;
}

// ──── Safety check ────
function isSafeMod(filePath, newContent) {
  if (!fs.existsSync(filePath)) return true;
  const original = fs.readFileSync(filePath, 'utf-8');
  return newContent.length >= original.length * 0.4;
}

// ──── Main Job (with fallbacks) ────
async function runOptimizationJob(jobId, repoUrl, mergeToMain) {
  const job = jobs[jobId];
  if (!job) return;
  job.status = 'cloning';
  try {
    const repoName = repoUrl.split('/').pop().replace('.git','');
    const repoPath = path.join(REPOS_DIR, jobId);
    await fs.remove(repoPath);
    const git = simpleGit();
    const authUrl = repoUrl.replace('https://', `https://${GITHUB_TOKEN}@`);
    job.log('Cloning repository...');
    await git.clone(authUrl, repoPath);
    
    job.status = 'analyzing';
    job.log('🧠 Genius AI scanning for schema & meta (no content changes)...');
    const prompt = buildGeniusPrompt(repoPath, repoName);
    job.log(`Prompt prepared (${prompt.length} chars). Sending to Gemini...`);

    let result;
    try {
      result = await model.generateContent({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 15000 },
      });
    } catch (e) {
      throw new Error(`Gemini API error: ${e.message}`);
    }

    const text = result.response.text();
    job.log(`Raw AI response length: ${text.length} chars.`);

    // Save full response for debugging
    const debugPath = path.join(repoPath, 'AI_RAW_RESPONSE.txt');
    fs.writeFileSync(debugPath, text, 'utf-8');
    job.log(`📄 Full response saved to AI_RAW_RESPONSE.txt in your repo.`);

    // Try to parse JSON
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (!data) data = extractJSONObject(text);
    if (!data) {
      const jsonMatch = text.match(/(\{[\s\S]*\})/);
      if (jsonMatch) try { data = JSON.parse(jsonMatch[1]); } catch (e) {}
    }

    // If still no JSON, fallback to manual schema injection
    if (!data || !data.modifications || !Array.isArray(data.modifications)) {
      job.log('⚠️ AI did not return valid JSON. Using fallback: add basic schema to all HTML files.');
      data = { 
        strategicReport: 'AI failed to produce structured JSON. Fallback: added basic Organization/WebSite schema.',
        modifications: []
      };
      // Find all HTML files and inject basic schema
      const htmlFiles = [];
      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(repoPath, full);
          if (entry.isDirectory() && !rel.startsWith('.git') && !rel.startsWith('node_modules')) {
            walk(full);
          } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
            htmlFiles.push(rel);
          }
        }
      };
      walk(repoPath);
      for (const filePath of htmlFiles) {
        const fullPath = path.join(repoPath, filePath);
        let content = fs.readFileSync(fullPath, 'utf-8');
        // Only add schema if not already present
        if (!content.includes('application/ld+json')) {
          const url = `https://${repoName}.com/${filePath}`; // placeholder
          const schema = generateBasicSchema(content, url);
          // Insert before </head> or at end
          if (content.includes('</head>')) {
            content = content.replace('</head>', `${schema}\n</head>`);
          } else if (content.includes('<body')) {
            content = content.replace('<body', `${schema}\n<body`);
          } else {
            content = schema + '\n' + content;
          }
          data.modifications.push({ path: filePath, content });
        }
      }
      job.log(`✅ Fallback added schema to ${data.modifications.length} HTML files.`);
    }

    // Save strategic report
    const report = data.strategicReport || 'No report generated.';
    fs.writeFileSync(path.join(repoPath, 'SEO_STRATEGY_REPORT.txt'), report, 'utf-8');

    job.status = 'applying';
    let applied = 0, skipped = 0;
    for (const mod of data.modifications) {
      if (!mod.path || typeof mod.content !== 'string') {
        skipped++;
        continue;
      }
      const filePath = path.join(repoPath, mod.path);
      if (!isSafeMod(filePath, mod.content)) {
        job.log(`⚠️ Skipped ${mod.path} (safety: too short)`);
        skipped++;
        continue;
      }
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, mod.content, 'utf-8');
      applied++;
    }
    job.log(`✅ Applied ${applied} changes (${skipped} skipped).`);

    // Git commit
    job.status = 'committing';
    const branchName = `seo-schema-aeo-${Date.now()}`;
    const repoGit = simpleGit(repoPath);
    await repoGit.addConfig('user.name', GITHUB_USERNAME);
    await repoGit.addConfig('user.email', `${GITHUB_USERNAME}@users.noreply.github.com`);
    await repoGit.checkoutLocalBranch(branchName);
    await repoGit.add('.');
    await repoGit.commit('🧠 Add SEO/AEO schema & meta (content unchanged)');
    await repoGit.push('origin', branchName);

    job.status = 'done';
    job.result = { branch: branchName, repo: repoUrl, merged: false, report };

    if (mergeToMain) {
      try {
        const octokit = new Octokit({ auth: GITHUB_TOKEN });
        const [owner, repoOnly] = repoUrl.replace('https://github.com/','').replace('.git','').split('/');
        await octokit.repos.merge({
          owner, repo: repoOnly, base: 'main', head: branchName,
          commit_message: '🧠 Merge schema & meta improvements'
        });
        job.result.merged = true;
        job.log('🚀 Merged to main!');
      } catch (e) { job.log(`Merge failed: ${e.message}`); }
    }
    job.log('🎉 Done!');
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.log(`❌ ${err.message}`);
  }
}

// ──── Routes ────
app.get('/api/job/:jobId/stream', (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const job = jobs[jobId];
  const sendUpdate = () => sendSSE(res, 'progress', { status: job.status, log: job.logs?.slice(-1)[0] || '' });
  sendUpdate();
  const interval = setInterval(() => {
    sendUpdate();
    if (job.status === 'done' || job.status === 'error') {
      sendSSE(res, 'complete', { status: job.status, result: job.result, error: job.error });
      clearInterval(interval);
      res.end();
    }
  }, 1000);
  req.on('close', () => clearInterval(interval));
});

app.post('/api/optimize', (req, res) => {
  const { repoUrl, mergeToMain } = req.body;
  if (!repoUrl?.includes('github.com')) return res.status(400).json({ error: 'Valid GitHub repo URL required' });
  const jobId = uuidv4();
  jobs[jobId] = { status: 'created', logs: [], log: (msg) => jobs[jobId].logs.push(msg) };
  jobs[jobId].log('🧠 SEO/AEO Engine – schema & meta only');
  runOptimizationJob(jobId, repoUrl, mergeToMain);
  res.json({ jobId });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🧠 SEO Genius Engine on port ${PORT}`));
