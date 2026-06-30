#!/usr/bin/env node
// Generiert die HTML-Ansichten der Planungs-Dokumente aus ihren Markdown-Quellen.
// Aufruf: `npm run docs:build` oder automatisch im pre-commit-Hook.
// Die *.html sind Generate — nicht von Hand editieren, die *.md sind die Quelle.

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const docsDir = path.join(__dirname, '..', 'docs');

// [Markdown-Quelle, HTML-Ziel] — zentrale Roadmap + verlinkte Detailpläne.
const DOCS = [
  ['ROADMAP.md', 'roadmap.html'],
  ['productivity-roadmap.md', 'productivity-roadmap.html'],
  ['agent-supervision-ux-plan.md', 'agent-supervision-ux-plan.html'],
  ['sidebar-folder-first-view-plan.md', 'sidebar-folder-first-view-plan.html'],
  ['sidebar-group-interactions-plan.md', 'sidebar-group-interactions-plan.html'],
  ['project-sidebar-plan.md', 'project-sidebar-plan.html'],
  ['windows-tray-fix-plan.md', 'windows-tray-fix-plan.html'],
  ['ci-autobuild-plan.md', 'ci-autobuild-plan.html'],
  ['handoff-store-plan.md', 'handoff-store-plan.html'],
];

// Bespoke, von Hand gepflegte HTML-Pläne (keine MD-Quelle) — nur zur Doku, nicht generiert:
//   session-display-plan.html, jbr-uebernahme-katalog.html, fork-landschaft.html

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageTitle(md, fallback) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/[*_`]/g, '') : fallback;
}

const THEME = `<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2128; --line:#30363d;
    --txt:#c9d1d9; --mut:#8b949e; --hi:#3fb950; --mid:#d29922; --lo:#f85149;
    --acc:#58a6ff; --code:#1f2630;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:32px;max-width:1100px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px;border-bottom:2px solid var(--line);padding-bottom:12px}
  h2{font-size:20px;margin:34px 0 10px;color:#fff}
  h3{font-size:16px;margin:22px 0 8px;color:var(--acc)}
  h4{font-size:14px;margin:16px 0 6px;color:#fff}
  a{color:var(--acc);text-decoration:none}
  a:hover{text-decoration:underline}
  code{background:var(--code);padding:1px 6px;border-radius:4px;font:12.5px/1.4 'Cascadia Code',Consolas,monospace;color:#e6edf3}
  pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:12px 0;background:var(--panel)}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  th{background:var(--panel2);color:#fff}
  blockquote{margin:12px 0;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:6px;color:var(--mut)}
  blockquote p{margin:0}
  ul{margin:6px 0 6px 0;padding-left:22px} li{margin:3px 0}
  input[type=checkbox]{margin-right:6px}
  hr{border:0;border-top:1px solid var(--line);margin:26px 0}
  strong{color:#fff}
</style>`;

// MD-Links auf .md-Pläne im Generat auf das jeweilige .html umbiegen.
const linkRewrite = new Map(DOCS.map(([src, out]) => [src, out]));

function rewriteLinks(html) {
  return html.replace(/href="([^"]+)"/g, (full, href) => {
    // Datei-Teil ggf. mit #anchor: nur den Datei-Teil umschreiben, Anker behalten.
    const hash = href.indexOf('#');
    const file = hash === -1 ? href : href.slice(0, hash);
    const frag = hash === -1 ? '' : href.slice(hash);
    const target = linkRewrite.get(file);
    return target ? `href="${target}${frag}"` : full;
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Heading-IDs (Slugs) nachrüsten, damit ROADMAP-Links per #anchor an die richtige
// Position springen. marked liefert <hN> ohne id; wir injizieren sie deterministisch.
function addHeadingIds(html) {
  const seen = Object.create(null);
  return html.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (full, tag, inner) => {
    const text = inner.replace(/<[^>]+>/g, '');
    let id = slugify(text);
    if (!id) return full;
    if (seen[id] != null) id = `${id}-${++seen[id]}`;
    else seen[id] = 0;
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });
}

let count = 0;
for (const [srcName, outName] of DOCS) {
  const srcPath = path.join(docsDir, srcName);
  if (!fs.existsSync(srcPath)) {
    console.warn(`uebersprungen (fehlt): ${srcName}`);
    continue;
  }
  const md = fs.readFileSync(srcPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const body = addHeadingIds(rewriteLinks(marked.parse(md, { gfm: true })));
  const title = escapeHtml(pageTitle(md, outName));
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- GENERIERT aus docs/${srcName} via scripts/build-docs.js. Nicht von Hand editieren. -->
${THEME}
</head>
<body>
${body}
</body>
</html>
`;
  fs.writeFileSync(path.join(docsDir, outName), html);
  count++;
}

console.log(`${count} Doc(s) generiert (ROADMAP + Detailplaene).`);
