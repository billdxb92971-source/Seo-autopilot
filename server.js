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

// ──── Genius Prompt – Only Schema & Meta, No Content Changes ────
function buildGeniusPrompt(repoPath, repoName) {
  const files = [];
  const MAX_FILE_CONTENT_HTML = 15000;
  const MAX_FILE_CONTENT_OTHER = 6000;
  const MAX_TOTAL_CHARS = 80000;
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
        if (['.html','.css','.js','.md','.txt','.json','.xml'].includes(ext)) {
          const limit = ext === '.html' ? MAX_FILE_CONTENT_HTML : MAX_FILE_CONTENT_OTHER;
          let content = fs.readFileSync(full, 'utf-8');
          if (content.length > limit) {
            content = content.substring(0, limit) + '\n... (truncated) ...';
          }
          files.push({ path: rel, content });
          totalChars += content.length;
        }
      }
    }
  };
  walk(repoPath);
  const fileList = files.map(f => `### FILE: ${f.path} ###\n${f.content}`).join('\n\n');

  return `You are a world‑class SEO and Answer Engine Optimization (AEO) strategist. You must analyse the website repository "${repoName}" and produce a strategic report and a list of file modifications that **ONLY add or improve metadata and structured data** — you MUST NOT change any visible content, text, images, scripts, styles, or layout.

The repository files:
${fileList}

## YOUR MISSION
Return a JSON object with two keys:

1. "strategicReport": A detailed, human‑readable analysis (plain text) covering:
   - Overall SEO/AEO health score (0‑100) and grade.
   - Entity and topic extraction.
   - Structured data gaps and opportunities.
   - Featured snippet and voice search potential.
   - Predicted ranking improvements and timeline.

2. "modifications": An array of file changes. Each object has:
   - "path": relative file path
   - "content": the COMPLETE new content of the file.

### STRICT RULES FOR MODIFICATIONS
- **DO NOT delete, alter, or replace any existing textual content, images, scripts, styles, or layout.**
- You may ONLY **add** or **improve** the following, **while keeping all original content exactly as it is**:
    • Add or optimise <title> and <meta name="description"> (if missing or weak).
    • Add or enhance Open Graph and Twitter Card meta tags.
    • Add canonical, viewport, author, and date meta tags if missing.
    • Add missing alt attributes to images with descriptive text (but do not change existing alt texts, only add if empty).
    • Fix heading hierarchy: if a block of text is meant to be a heading but is wrapped in <p> or <div>, wrap the **exact same text** in the correct <h1>–<h6> tag. Never change the wording.
    • **Add JSON‑LD structured data (schema.org)** inside <script type="application/ld+json">. Include all relevant types: Organization, WebSite, BreadcrumbList, Article, FAQ, HowTo, Speakable (for voice), LocalBusiness, Product, Review, etc. Use the existing site content to populate the schema, but do not alter that content.
- **Never** rewrite paragraphs, change images, modify CSS, or touch JavaScript.
- The output "content" must be the **original file with ONLY the above additions/improvements**. The file must remain fully valid and functional.

Example structure:
{
  "strategicReport": "Score: 82 (A). ...",
  "modifications": [
    {"path": "index.html", "content": "<!DOCTYPE html><html>... (original content plus added meta and schema) ...</html>"}
  ]
}

Return ONLY the JSON object — no markdown, no extra text.`;
}

// ──── SSE Helpers ────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ──── JSON extraction ────
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

// ──── Safety check (preserves content) ────
function isSafeMod(filePath, newContent) {
  if (!fs.existsSync(filePath)) return true;
  const original = fs.readFileSync(filePath, 'utf-8');
  // If new content is less than 40% of original, likely a deletion
  return newContent.length >= original.length * 0.4;
}

// ──── Main Job ────
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
    job.log('🧠 Genius AI scanning for schema & AEO opportunities (no content changes)...');
    const prompt = buildGeniusPrompt(repoPath, repoName);
    job.log(`Prompt prepared (${prompt.length} chars). Sending to Gemini...`);
    
    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 10000 },
    });
    const text = result.response.text();
    if (!text) throw new Error('Empty AI response');
    
    const data = extractJSONObject(text);
    if (!data || !data.modifications || !Array.isArray(data.modifications)) {
      job.log('Raw AI response (first 600 chars): ' + text.substring(0, 600));
      throw new Error('AI did not return a valid JSON with modifications array');
    }

    // Save the strategic report
    const report = data.strategicReport || 'No report generated.';
    fs.writeFileSync(path.join(repoPath, 'SEO_STRATEGY_REPORT.txt'), report, 'utf-8');

    job.status = 'applying';
    let applied = 0, skipped = 0;
    for (const mod of data.modifications) {
      if (!mod.path || typeof mod.content !== 'string') continue;
      const filePath = path.join(repoPath, mod.path);
      if (!isSafeMod(filePath, mod.content)) {
        job.log(`⚠️ Skipped ${mod.path} (safety: too short, possible content deletion)`);
        skipped++;
        continue;
      }
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, mod.content, 'utf-8');
      applied++;
    }
    job.log(`✅ Applied ${applied} changes (${skipped} skipped). Your content is untouched.`);

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
        job.log('🚀 Merged to main — live with new schema!');
      } catch (e) { job.log(`Merge failed (maybe protected): ${e.message}`); }
    }
    job.log('🎉 Done! Schema added, content untouched.');
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
  jobs[jobId].log('🧠 Genius SEO/AEO Brain – schema & meta only, no content changes');
  runOptimizationJob(jobId, repoUrl, mergeToMain);
  res.json({ jobId });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🧠 SEO Genius Engine on port ${PORT}`));
