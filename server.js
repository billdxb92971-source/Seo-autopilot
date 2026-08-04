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

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'SEO-Agent';
const REPOS_DIR = path.join(__dirname, 'repos');
fs.ensureDirSync(REPOS_DIR);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Use the latest Flash model – guaranteed to exist
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// In‑memory job store
const jobs = {};

// --- Helper: build AI prompt from repo contents (severely truncated) ---
function buildOptimizationPrompt(repoPath, repoName) {
  const files = [];
  const MAX_FILE_CONTENT = 1000;  // characters per file
  const MAX_TOTAL_CHARS = 20000;  // stop after this many characters total

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
          const content = fs.readFileSync(full, 'utf-8').substring(0, MAX_FILE_CONTENT);
          files.push({ path: rel, content });
          totalChars += content.length;
        }
      }
    }
  };
  walk(repoPath);

  const fileList = files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');

  return `You are an expert SEO engineer. I have cloned the repository "${repoName}". Below is a snapshot of its source files. Analyse them and produce a list of EXACT file modifications that will dramatically improve the SEO, user experience, and accessibility of the website.

Return ONLY a JSON array of objects. Each object must have:
- "path": relative file path (string)
- "content": the COMPLETE new content of the file (string)

Focus on:
- Adding/improving <title> and <meta name="description"> in HTML files.
- Adding JSON-LD structured data (Organization, WebSite, BreadcrumbList) inside <script type="application/ld+json">.
- Fixing heading hierarchy (h1, h2, h3).
- Adding missing alt attributes to images.
- Optimising internal links and anchor texts.
- Improving content readability and keyword usage (natural).
- Adding Open Graph and Twitter Card meta tags.
- Ensuring viewport meta tag is present.
- Adding canonical URLs where needed.

Do NOT change JavaScript functionality or CSS. Return ONLY the JSON array, no other text. Example:
[{"path": "index.html", "content": "<!DOCTYPE html><html>..."}]

Repository files:
${fileList}`;
}

// --- SSE helper ---
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- Attempt to extract JSON array from messy AI response ---
function extractJSONArray(text) {
  // Remove markdown fences
  let cleaned = text.replace(/```json|```/g, '').trim();
  // Try to find the first '[' and last ']'
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.substring(start, end + 1));
    } catch (e) {}
  }
  return null;
}

// --- Job runner ---
async function runOptimizationJob(jobId, repoUrl, mergeToMain) {
  const job = jobs[jobId];
  if (!job) return;
  job.status = 'cloning';
  try {
    const repoName = repoUrl.split('/').pop().replace('.git','');
    const repoPath = path.join(REPOS_DIR, jobId);
    await fs.remove(repoPath);

    // Clone repo using GitHub token
    const git = simpleGit();
    const authUrl = repoUrl.replace('https://', `https://${GITHUB_TOKEN}@`);
    job.log('Cloning repository...');
    await git.clone(authUrl, repoPath);
    job.status = 'analyzing';
    job.log('AI analysing code... (may take 20-30 seconds)');

    // Build prompt from code
    const prompt = buildOptimizationPrompt(repoPath, repoName);
    job.log(`Prompt size: ${prompt.length} characters (max tokens ~${Math.round(prompt.length/4)})`);

    // Call Gemini with timeout
    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
    });
    const response = result.response;
    const text = response.text();
    if (!text || text.trim().length === 0) {
      throw new Error('AI returned empty response');
    }

    job.log('AI response received. Parsing...');

    // Try to parse directly, then fallback extraction
    let modifications = extractJSONArray(text);
    if (!modifications) {
      // Last resort: try to parse the whole text as JSON array
      try {
        modifications = JSON.parse(text.trim());
      } catch (e) {}
    }

    if (!modifications || !Array.isArray(modifications) || modifications.length === 0) {
      job.log('Raw AI response (first 500 chars):');
      job.log(text.substring(0, 500));
      throw new Error('AI did not return a valid JSON array of modifications');
    }

    job.status = 'applying';
    job.log(`Applying ${modifications.length} file changes...`);
    for (const mod of modifications) {
      if (!mod.path || typeof mod.content !== 'string') {
        job.log(`Skipping invalid mod: ${JSON.stringify(mod)}`);
        continue;
      }
      const filePath = path.join(repoPath, mod.path);
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, mod.content, 'utf-8');
    }

    // Git add, commit, push
    job.status = 'committing';
    const branchName = `seo-optimize-${Date.now()}`;
    const repoGit = simpleGit(repoPath);
    await repoGit.addConfig('user.name', GITHUB_USERNAME);
    await repoGit.addConfig('user.email', `${GITHUB_USERNAME}@users.noreply.github.com`);
    await repoGit.checkoutLocalBranch(branchName);
    await repoGit.add('.');
    await repoGit.commit('🤖 AI SEO optimisation – improved meta, schema, accessibility');
    await repoGit.push('origin', branchName);

    job.status = 'done';
    job.result = { branch: branchName, repo: repoUrl, merged: false };

    // Optionally merge to main
    if (mergeToMain) {
      try {
        const octokit = new Octokit({ auth: GITHUB_TOKEN });
        const [owner, repoNameOnly] = repoUrl.replace('https://github.com/','').replace('.git','').split('/');
        await octokit.repos.merge({
          owner,
          repo: repoNameOnly,
          base: 'main',
          head: branchName,
          commit_message: '🚀 Auto‑merge AI SEO optimisations'
        });
        job.result.merged = true;
        job.log('✅ Merged to main – deployment triggered!');
      } catch (mergeErr) {
        job.log(`⚠️ Merge to main failed (maybe branch protection): ${mergeErr.message}`);
      }
    }
    job.log('🎉 Optimisation complete!');
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.log(`❌ Error: ${err.message}`);
  }
}

// --- SSE endpoint: listen for job updates ---
app.get('/api/job/:jobId/stream', (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const job = jobs[jobId];
  const sendUpdate = () => {
    sendSSE(res, 'progress', {
      status: job.status,
      log: job.logs?.slice(-1)[0] || ''
    });
  };

  // Send initial
  sendUpdate();
  const interval = setInterval(() => {
    sendUpdate();
    if (job.status === 'done' || job.status === 'error') {
      sendSSE(res, 'complete', {
        status: job.status,
        result: job.result,
        error: job.error
      });
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

// --- Trigger optimisation ---
app.post('/api/optimize', (req, res) => {
  const { repoUrl, mergeToMain } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });
  if (!repoUrl.includes('github.com')) return res.status(400).json({ error: 'Only GitHub repos supported' });

  const jobId = uuidv4();
  jobs[jobId] = {
    status: 'created',
    logs: [],
    log: (msg) => jobs[jobId].logs.push(msg)
  };
  jobs[jobId].log('Job created');

  // Run async
  runOptimizationJob(jobId, repoUrl, mergeToMain).catch((err) => {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
    jobs[jobId].log(`Unhandled error: ${err.message}`);
  });

  res.json({ jobId });
});

// --- Serve frontend ---
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SEO Autopilot running on port ${PORT}`));
