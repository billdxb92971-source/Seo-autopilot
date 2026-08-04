require('dotenv').config();
const express = require('express');
const { GoogleGenAI, Type } = require('@google/genai');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'seo-agent';
const APP_SECRET = process.env.APP_SECRET; // shared secret gate -- NOT the Gemini key
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low'; // minimal|low|medium|high

if (!GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY not set -- analysis will fail.');
if (!GITHUB_TOKEN) console.warn('WARNING: GITHUB_TOKEN not set -- cloning/pushing will fail.');
if (!APP_SECRET) {
  console.warn(
    'WARNING: APP_SECRET not set. The /api/optimize endpoint will be OPEN TO ANYONE who finds ' +
    'this URL, and it can push commits (and optionally merge to main) using your GITHUB_TOKEN. ' +
    'Set APP_SECRET before deploying this publicly.'
  );
}

// Cloned repos live in the OS temp dir, never inside this app's own folder, so they can't
// accidentally get committed to this tool's repo, and the OS cleans them up over time too.
const REPOS_DIR = path.join(os.tmpdir(), 'seo-genius-repos');
fs.ensureDirSync(REPOS_DIR);

// Current Google Gen AI SDK. Gemini 3.x models ignore temperature/top_p/top_k/candidateCount
// (deprecated, and Google says future generations may reject requests that include them), so
// none of those are set below -- determinism instead comes from the system instruction and
// from forcing a strict response schema.
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-3.6-flash';

const jobs = {};
const JOB_TTL_MS = 30 * 60 * 1000; // jobs are cleared 30 min after completion so memory doesn't grow forever

function scheduleJobCleanup(jobId) {
  setTimeout(() => { delete jobs[jobId]; }, JOB_TTL_MS);
}

// ──── Simple shared-secret auth ────
// This tool can push commits and merge to main using your GITHUB_TOKEN. Without a check here,
// anyone who finds the deployed URL could point it at any repo your token can write to.
// This is APP_SECRET -- a value YOU invent -- never the Gemini key.
function requireAuth(req, res, next) {
  if (!APP_SECRET) return next(); // no secret configured (local dev) -- allowed, but warned above
  const provided = req.headers['x-api-key'];
  if (provided !== APP_SECRET) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header.' });
  }
  next();
}

// ──── Prompt builder – ONLY HTML files, bounded context ────
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

  if (files.length === 0) return { prompt: null, fileCount: 0 };

  const fileList = files.map(f => `### FILE: ${f.path} ###\n${f.content}`).join('\n\n');

  const prompt = `Repository: "${repoName}"

Files:
${fileList}

Analyse these HTML files and produce SEO/AEO improvements as instructed in your system prompt. \
Return results matching the required JSON schema exactly.`;

  return { prompt, fileCount: files.length };
}

const SYSTEM_INSTRUCTION = `You are an SEO/AEO (answer-engine optimization) expert. You are given \
the HTML files of a real website's repository. Improve their discoverability for both traditional \
search engines and AI answer engines (ChatGPT, Perplexity, Gemini's own search, etc.).

RULES -- follow exactly:
- DO NOT change any visible text, images, scripts, styles, or layout.
- ONLY add or improve:
  - <title> and <meta name="description">
  - Open Graph / Twitter Card meta tags
  - canonical, viewport, author, date meta
  - missing alt attributes on images (write descriptive text based on context/filename)
  - heading hierarchy (wrap EXISTING text in correct <h1>-<h6> tags -- never change wording)
  - JSON-LD schema.org markup inside <script type="application/ld+json">: at minimum \
Organization and WebSite, plus any relevant types (Article, FAQPage, HowTo, Product, etc.) based \
on the page's actual content
- Never fabricate facts (prices, addresses, reviews, ratings) in schema markup that aren't \
already present in the visible page content.
- For each file you modify, output its FULL content -- the original file with only the above \
additions/fixes applied. Do not omit or truncate unchanged sections.
- Only include a file in "modifications" if you actually changed something in it.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    strategicReport: {
      type: Type.STRING,
      description: 'Max 300 words. Include a 0-100 health score, key gaps, and opportunities.',
    },
    modifications: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: 'Relative file path exactly as given in input' },
          content: { type: Type.STRING, description: 'Full new file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  required: ['strategicReport', 'modifications'],
};

// ──── Fallback schema generator (used only if the AI call fails entirely) ────
function generateBasicSchema(url) {
  const siteName = path.basename(url).replace('.html', '') || 'Website';
  const org = { '@context': 'https://schema.org', '@type': 'Organization', name: siteName, url };
  const website = { '@context': 'https://schema.org', '@type': 'WebSite', name: siteName, url };
  return `<script type="application/ld+json">${JSON.stringify(org)}</script>\n<script type="application/ld+json">${JSON.stringify(website)}</script>`;
}

// A modification is rejected if it's suspiciously shorter than the original --
// a sign the model truncated or dropped content instead of only adding to it.
function isSafeMod(filePath, newContent) {
  if (!fs.existsSync(filePath)) return true;
  const original = fs.readFileSync(filePath, 'utf-8');
  return newContent.length >= original.length * 0.4;
}

async function runOptimizationJob(jobId, repoUrl, mergeToMain) {
  const job = jobs[jobId];
  if (!job) return;
  job.status = 'cloning';
  const repoPath = path.join(REPOS_DIR, jobId);

  try {
    const repoName = repoUrl.split('/').pop().replace('.git', '');
    await fs.remove(repoPath);
    const git = simpleGit();
    const authUrl = repoUrl.replace('https://', `https://${GITHUB_TOKEN}@`);
    job.log('Cloning repository...');
    await git.clone(authUrl, repoPath);

    job.status = 'analyzing';
    job.log('Scanning HTML files for SEO/AEO opportunities (content will not be changed)...');
    const { prompt, fileCount } = buildGeniusPrompt(repoPath, repoName);

    if (!prompt) {
      throw new Error('No .html files found in this repo. This tool only edits static HTML files.');
    }
    job.log(`Found ${fileCount} HTML file(s). Sending to ${GEMINI_MODEL}...`);

    let data;
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL.toUpperCase() },
        },
      });
      job.log(`Received AI response (${response.text.length} chars).`);
      data = JSON.parse(response.text); // schema-enforced, so this should always be valid JSON
    } catch (e) {
      job.log(`AI call/parse failed (${e.message}). Falling back to basic Organization/WebSite schema only.`);
      data = { strategicReport: `AI analysis failed: ${e.message}. Applied fallback: basic schema only.`, modifications: [] };

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
        if (!content.includes('application/ld+json')) {
          const schema = generateBasicSchema(`https://${repoName}.com/${filePath}`);
          content = content.includes('</head>')
            ? content.replace('</head>', `${schema}\n</head>`)
            : `${schema}\n${content}`;
          data.modifications.push({ path: filePath, content });
        }
      }
      job.log(`Fallback added schema to ${data.modifications.length} file(s).`);
    }

    const report = data.strategicReport || 'No report generated.';
    job.report = report; // kept in memory / returned via API -- NOT committed into the user's repo

    job.status = 'applying';
    let applied = 0, skipped = 0;
    for (const mod of data.modifications) {
      if (!mod.path || typeof mod.content !== 'string') { skipped++; continue; }
      const filePath = path.join(repoPath, mod.path);
      // Guard against path traversal (e.g. "../../etc/passwd") from a malformed AI response
      if (!filePath.startsWith(repoPath)) { skipped++; job.log(`Skipped ${mod.path} (unsafe path)`); continue; }
      if (!isSafeMod(filePath, mod.content)) {
        job.log(`Skipped ${mod.path} (safety check: new content much shorter than original)`);
        skipped++;
        continue;
      }
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, mod.content, 'utf-8');
      applied++;
    }
    job.log(`Applied ${applied} change(s), skipped ${skipped}.`);

    if (applied === 0) {
      job.status = 'done';
      job.result = { repo: repoUrl, merged: false, applied: 0, report };
      job.log('No changes to commit.');
      return;
    }

    job.status = 'committing';
    const branchName = `seo-aeo-${Date.now()}`;
    const repoGit = simpleGit(repoPath);
    await repoGit.addConfig('user.name', GITHUB_USERNAME);
    await repoGit.addConfig('user.email', `${GITHUB_USERNAME}@users.noreply.github.com`);
    await repoGit.checkoutLocalBranch(branchName);
    await repoGit.add('.');
    await repoGit.commit('SEO/AEO: add meta tags and schema markup (content unchanged)');
    await repoGit.push('origin', branchName);
    job.log(`Pushed branch ${branchName}.`);

    job.status = 'done';
    job.result = { branch: branchName, repo: repoUrl, merged: false, applied, report };

    if (mergeToMain) {
      try {
        const octokit = new Octokit({ auth: GITHUB_TOKEN });
        const [owner, repoOnly] = repoUrl.replace('https://github.com/', '').replace('.git', '').split('/');
        await octokit.repos.merge({
          owner, repo: repoOnly, base: 'main', head: branchName,
          commit_message: 'Merge SEO/AEO improvements',
        });
        job.result.merged = true;
        job.log('Merged to main.');
      } catch (e) {
        job.log(`Merge to main failed (branch was still pushed successfully): ${e.message}`);
      }
    }
    job.log('Done.');
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.log(`Error: ${err.message}`);
  } finally {
    await fs.remove(repoPath).catch(() => {});
    scheduleJobCleanup(jobId);
  }
}

// ──── Routes ────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Not behind requireAuth: browsers' EventSource API can't send custom headers, so this can't
// check x-api-key. That's acceptable because job IDs are unguessable UUIDs generated only by
// an authenticated call to /api/optimize, and this endpoint is read-only (log output) -- it
// can't be used to trigger anything on its own.
app.get('/api/job/:jobId/stream', (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const job = jobs[jobId];
  let lastLogIndex = 0;
  const sendUpdate = () => {
    const newLogs = job.logs.slice(lastLogIndex);
    lastLogIndex = job.logs.length;
    sendSSE(res, 'progress', { status: job.status, logs: newLogs });
  };
  sendUpdate();
  const interval = setInterval(() => {
    sendUpdate();
    if (job.status === 'done' || job.status === 'error') {
      sendSSE(res, 'complete', { status: job.status, result: job.result, error: job.error, report: job.report });
      clearInterval(interval);
      res.end();
    }
  }, 1000);
  req.on('close', () => clearInterval(interval));
});

app.post('/api/optimize', requireAuth, (req, res) => {
  const { repoUrl, mergeToMain } = req.body || {};
  if (!repoUrl || !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repoUrl)) {
    return res.status(400).json({ error: 'A valid https://github.com/owner/repo URL is required.' });
  }
  if (!GEMINI_API_KEY || !GITHUB_TOKEN) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY or GITHUB_TOKEN.' });
  }
  const jobId = uuidv4();
  jobs[jobId] = { status: 'created', logs: [], log(msg) { this.logs.push(msg); } };
  jobs[jobId].log('SEO/AEO agent starting -- schema & meta only, no visible content changes.');
  runOptimizationJob(jobId, repoUrl, Boolean(mergeToMain));
  res.json({ jobId });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    githubConfigured: Boolean(GITHUB_TOKEN),
    authRequired: Boolean(APP_SECRET),
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEO/AEO Genius Engine on port ${PORT} (model: ${GEMINI_MODEL})`);
});
