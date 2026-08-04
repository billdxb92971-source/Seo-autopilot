require('dotenv').config();
const express = require('express');
const { GoogleGenAI, Type } = require('@google/genai');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cheerio = require('cheerio');
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

const REPOS_DIR = path.join(os.tmpdir(), 'seo-genius-repos');
fs.ensureDirSync(REPOS_DIR);

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-3.6-flash';

const jobs = {};
const JOB_TTL_MS = 30 * 60 * 1000;

function scheduleJobCleanup(jobId) {
  setTimeout(() => { delete jobs[jobId]; }, JOB_TTL_MS);
}

function requireAuth(req, res, next) {
  if (!APP_SECRET) return next();
  const provided = req.headers['x-api-key'];
  if (provided !== APP_SECRET) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header.' });
  }
  next();
}

// ──── Extract a COMPACT summary of a page instead of its full content ────
// This is the fix for the previous design: full-file round-tripping falls apart on
// large files (some of this repo's HTML is 400KB+). Gemini never needs to see or
// reproduce the whole file -- it only needs enough context to decide what head tags,
// schema, and alt text to add. The server applies those additions directly to the
// real, full, untruncated file on disk using cheerio (a real HTML parser), not string
// matching -- so nothing here depends on file size.
function extractPageSummary(html, maxImages = 40, maxBodyChars = 2000) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const hasViewport = $('meta[name="viewport"]').length > 0;
  const hasOgTags = $('meta[property^="og:"]').length > 0;
  const existingSchemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const type = parsed['@type'];
      if (type) existingSchemaTypes.push(type);
    } catch (_) { /* ignore unparsable existing schema */ }
  });

  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 5);
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 8);

  const missingAltImages = [];
  $('img').each((_, el) => {
    if (missingAltImages.length >= maxImages) return;
    const alt = $(el).attr('alt');
    const src = $(el).attr('src');
    if (src && !alt?.trim()) {
      // grab nearby text for context, so the model can write a real description, not a guess
      const nearbyText = $(el).closest('figure, div, section, article').find('figcaption, p').first().text().trim();
      missingAltImages.push({ src, nearbyText: nearbyText.slice(0, 150) });
    }
  });

  const bodyTextSample = $('body').text().replace(/\s+/g, ' ').trim().slice(0, maxBodyChars);

  return {
    title,
    metaDescription,
    canonical,
    hasViewport,
    hasOgTags,
    existingSchemaTypes,
    h1s,
    h2s,
    missingAltImageCount: missingAltImages.length,
    missingAltImages: missingAltImages.slice(0, maxImages),
    bodyTextSample,
    originalByteLength: html.length,
  };
}

const SYSTEM_INSTRUCTION = `You are an SEO/AEO (answer-engine optimization) expert. For each page \
you're given a compact SUMMARY (not the full HTML -- some of these files are hundreds of KB, so \
you never see or need to reproduce the whole thing). Based on each summary, decide what to ADD.

You must NEVER be asked to output a full page. For each file, return:
- "headAdditions": a single string of raw HTML tags to insert into <head> -- only tags that are
  MISSING based on the summary (missing meta description, missing OG tags, missing canonical,
  missing viewport, missing/incomplete schema.org JSON-LD). If everything needed is already
  present, return an empty string for that file.
- "altFixes": for each image in "missingAltImages", write a real descriptive alt text using the
  page's title/headings and the image's nearby text for context. Never invent specific facts
  (prices, names, counts) not implied by the context provided.

Rules:
- Only ADD tags. Never suggest removing or rewriting existing tags.
- JSON-LD schema: include Organization and WebSite at minimum if not already present in
  existingSchemaTypes, using the page's title/body sample to fill in plausible name/description
  fields -- do not invent addresses, phone numbers, prices, or ratings that aren't implied by the
  content sample.
- headAdditions must be valid, complete HTML tags (e.g. a full <script type="application/ld+json">...
  </script> block, full <meta .../> tags) -- not fragments.
- If a page already has everything (hasViewport true, hasOgTags true, metaDescription present,
  Organization+WebSite in existingSchemaTypes, missingAltImageCount is 0), return headAdditions as
  an empty string and altFixes as an empty array for that file -- don't invent busywork.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    strategicReport: {
      type: Type.STRING,
      description: 'Max 300 words. Include a 0-100 health score, key gaps, and opportunities.',
    },
    fileChanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: 'Relative file path exactly as given in input' },
          headAdditions: { type: Type.STRING, description: 'Raw HTML tags to insert before </head>, or "" if nothing needed' },
          altFixes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                imageSrc: { type: Type.STRING },
                altText: { type: Type.STRING },
              },
              required: ['imageSrc', 'altText'],
            },
          },
        },
        required: ['path', 'headAdditions', 'altFixes'],
      },
    },
  },
  required: ['strategicReport', 'fileChanges'],
};

function findHtmlFiles(repoPath) {
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoPath, full);
      if (entry.isDirectory() && !rel.startsWith('.git') && !rel.startsWith('node_modules')) {
        walk(full);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  walk(repoPath);
  return files;
}

// Applies headAdditions + altFixes to the REAL, full, on-disk file via cheerio DOM ops --
// never via full-file string replacement, so file size is irrelevant and body content is
// structurally guaranteed untouched (we only ever call methods that touch <head> or an
// img's alt attribute).
function applyFileChanges(repoPath, change, job) {
  const filePath = path.join(repoPath, change.path);
  if (!filePath.startsWith(repoPath)) {
    job.log(`Skipped ${change.path} (unsafe path)`);
    return false;
  }
  if (!fs.existsSync(filePath)) {
    job.log(`Skipped ${change.path} (file not found)`);
    return false;
  }

  const original = fs.readFileSync(filePath, 'utf-8');
  const $ = cheerio.load(original);
  const bodyTextBefore = $('body').text();

  let changed = false;

  if (change.headAdditions && change.headAdditions.trim()) {
    // avoid inserting an exact duplicate if this exact block is somehow already present
    if (!original.includes(change.headAdditions.trim())) {
      $('head').append('\n' + change.headAdditions.trim() + '\n');
      changed = true;
    }
  }

  let altApplied = 0;
  for (const fix of change.altFixes || []) {
    if (!fix.imageSrc || !fix.altText) continue;
    // Match by comparing the actual attribute value rather than building a CSS selector
    // string from user/AI-controlled text, so odd characters in a src can't break selection.
    const img = $('img').filter((_, el) => $(el).attr('src') === fix.imageSrc).first();
    if (img.length > 0 && !img.attr('alt')?.trim()) {
      img.attr('alt', fix.altText);
      altApplied++;
      changed = true;
    }
  }

  if (!changed) {
    job.log(`No applicable changes for ${change.path} (nothing missing, or images already fixed).`);
    return false;
  }

  // Structural safety check: since we only ever call .append() on <head> and .attr('alt', ...)
  // on specific <img> tags, visible body text should be byte-identical. If it isn't, something
  // unexpected happened (e.g. a malformed selector affecting more than intended) -- bail out
  // rather than write a file that might have altered visible content.
  const bodyTextAfter = $('body').text();
  if (bodyTextAfter !== bodyTextBefore) {
    job.log(`Skipped ${change.path} (safety check: visible body text would change -- not applying)`);
    return false;
  }

  fs.writeFileSync(filePath, $.html(), 'utf-8');
  job.log(`Updated ${change.path}: ${change.headAdditions?.trim() ? 'added head tags/schema' : 'no head changes'}, ${altApplied} alt attribute(s) fixed.`);
  return true;
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
    const htmlFiles = findHtmlFiles(repoPath);
    if (htmlFiles.length === 0) {
      throw new Error('No .html files found in this repo. This tool only edits static HTML files.');
    }

    job.log(`Found ${htmlFiles.length} HTML file(s). Building compact summaries (not full content)...`);
    const summaries = htmlFiles.map((relPath) => {
      const html = fs.readFileSync(path.join(repoPath, relPath), 'utf-8');
      const summary = extractPageSummary(html);
      job.log(`  ${relPath}: ${summary.originalByteLength} bytes on disk -> summary only sent to AI.`);
      return { path: relPath, ...summary };
    });

    job.log(`Sending ${summaries.length} page summaries to ${GEMINI_MODEL}...`);

    let data;
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: JSON.stringify({ repository: repoName, pages: summaries }, null, 2),
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL.toUpperCase() },
          maxOutputTokens: 20000, // summaries in, small additions out -- nowhere near the ~64k cap now
        },
      });

      const text = response.text;
      if (!text) {
        const finishReason = response.candidates?.[0]?.finishReason || 'unknown';
        const blockReason = response.promptFeedback?.blockReason;
        throw new Error(
          `Gemini returned no text (finishReason: ${finishReason}` +
          (blockReason ? `, blockReason: ${blockReason}` : '') + `).`
        );
      }

      job.log(`Received AI response (${text.length} chars).`);
      data = JSON.parse(text);
      job.log(`AI proposed changes for ${data.fileChanges.length} file(s).`);
    } catch (e) {
      job.log(`AI call/parse failed (${e.message}). Falling back to basic Organization/WebSite schema only.`);
      data = {
        strategicReport: `AI analysis failed: ${e.message}. Applied fallback: basic schema only.`,
        fileChanges: summaries
          .filter((s) => !s.existingSchemaTypes.includes('Organization'))
          .map((s) => ({
            path: s.path,
            headAdditions:
              `<script type="application/ld+json">${JSON.stringify({
                '@context': 'https://schema.org', '@type': 'Organization', name: s.title || repoName,
              })}</script>\n` +
              `<script type="application/ld+json">${JSON.stringify({
                '@context': 'https://schema.org', '@type': 'WebSite', name: s.title || repoName,
              })}</script>`,
            altFixes: [],
          })),
      };
    }

    const report = data.strategicReport || 'No report generated.';
    job.report = report;

    job.status = 'applying';
    let applied = 0;
    for (const change of data.fileChanges) {
      if (applyFileChanges(repoPath, change, job)) applied++;
    }
    job.log(`Applied changes to ${applied} of ${data.fileChanges.length} proposed file(s).`);

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
  jobs[jobId] = {
    status: 'created',
    logs: [],
    log(msg) {
      this.logs.push(msg);
      console.log(`[job ${jobId}] ${msg}`);
    },
  };
  jobs[jobId].log('SEO/AEO agent starting -- head/schema/alt-text additions only, no visible content changes.');
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
