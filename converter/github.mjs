// Reporting back to Lewis: the run summary on the Actions page, and a GitHub
// issue (which GitHub emails to the repo owner) when something needs a look.
import fs from 'node:fs/promises';

export async function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await fs.appendFile(file, markdown + '\n');
}

export async function openOrUpdateIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return false;
  const api = (p, init = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  try {
    const res = await api('/issues?state=open&creator=github-actions%5Bbot%5D&per_page=50');
    const open = res.ok ? await res.json() : [];
    const existing = Array.isArray(open) ? open.find((i) => i.title === title && !i.pull_request) : null;
    if (existing) {
      await api(`/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    } else {
      await api('/issues', { method: 'POST', body: JSON.stringify({ title, body }) });
    }
    return true;
  } catch (e) {
    console.warn(`Couldn't open an issue: ${e.message}`);
    return false;
  }
}
