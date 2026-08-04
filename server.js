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
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// In‑memory job store
const jobs = {};

// --- Helper: build AI prompt from repo contents ---
function buildOptimizationPrompt(repoPath, repoName) {
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoPath, full);
      if (entry.isDirectory() && !rel.startsWith('.git')) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.html','.css','.js','.md','.txt','.json','.xml','.svg','.png','.jpg','.jpeg'].includes(ext) || ext === '') {
          const content = fs.readFileSync(full, 'utf-8').substring(0, 2000); // limit per file
          files.push({ path: rel, content });
        }
      }
    }
  };
  walk(repoPath);

  const fileList = files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');

  return `You are an expert SEO engineer. I have cloned the repository "${repoName}". Below is a snapshot of its files. Analyse them and produce a list of EXACT file modifications that will dramatically improve the SEO, user experience, and accessibility of the website.

Return a JSON array of objects. Each object must have:
- "path": relative file path
- "content": the COMPLETE new content of the file (overwrite entire file)

Focus on:
1. Adding/improving <title> and <meta name="description"> in HTML files.
2. Adding JSON-LD structured data (Schema.org) inside <script type="application/ld+json">.
3. Fixing heading hierarchy (h1, h2, h3).
4. Adding missing alt attributes to images.
5. Optimising internal links and anchor texts.
6. Improving content readability and keyword usage (natural).
7. Compressing images (you can output a placeholder suggestion, we'll handle compression later).
8. Adding Open Graph and Twitter Card meta tags.
9. Ensuring viewport meta tag is present.
10. Adding canonical URLs where needed.

Do NOT change any JavaScript functionality unless it directly harms SEO. Do NOT alter CSS unless it's for critical rendering path improvements.

Return ONLY the JSON array, no other text. Example:
[{"path": "index.html", "content": "<!DOCTYPE html><html>..."}]

Repository files:
${fileList}`;
}

// --- SSE helper ---
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

    // Build prompt from code
    const prompt = buildOptimizationPrompt(repoPath, repoName);
    job.log('AI analysing code...');
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const cleaned = text.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI did not return valid JSON array');
    const modifications = JSON.parse(match[0]);

    job.status = 'applying';
    job.log(`Applying ${modifications.length} file changes...`);
    for (const mod of modifications) {
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
  const interval = setInterval(() => {
    sendSSE(res, 'progress', { status: job.status, log: job.logs?.slice(-1)[0] });
    if (job.status === 'done' || job.status === 'error') {
      sendSSE(res, 'complete', { status: job.status, result: job.result, error: job.error });
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
  jobs[jobId] = { status: 'created', logs: [], log: (msg) => jobs[jobId].logs.push(msg) };
  jobs[jobId].log('Job created');

  // Run async
  runOptimizationJob(jobId, repoUrl, mergeToMain);

  res.json({ jobId });
});

// --- Serve frontend ---
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SEO Autopilot running on port ${PORT}`));
