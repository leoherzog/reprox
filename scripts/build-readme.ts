/**
 * Build script to generate static HTML and markdown for the README page.
 *
 * Reads local README.md, transforms it to HTML with:
 * - Syntax highlighting via highlight.js (bash only)
 * - GitHub-flavored markdown styling
 * - All CSS inlined, purged of unused selectors, and minified
 *
 * Exports both HTML and raw markdown with {{BASE_URL}} and {{FINGERPRINT_COMMENT}} placeholders.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import markedAlert from 'marked-alert';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import { PurgeCSS } from 'purgecss';
import postcss from 'postcss';
import cssnano from 'cssnano';

// Register only bash for minimal bundle size
hljs.registerLanguage('bash', bash);

/**
 * Parse GitHub repo (owner/repo) from git remote URL
 * Supports: ssh://git@github.com/owner/repo, git@github.com:owner/repo.git, https://github.com/owner/repo.git
 */
function getGitHubRepo(): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    // Match owner/repo from various GitHub URL formats
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
  } catch {
    // Ignore errors
  }

  // Fallback if parsing fails
  return 'leoherzog/reprox';
}

/**
 * Get version info — prefer package.json (set by release bump), then git tag, then commit.
 * package.json is authoritative on the prod branch; git tags may not be fetched in
 * Cloudflare Workers Builds checkouts, so we can't rely on `git describe` alone.
 */
function getGitInfo(): { version: string; url: string; label: string } {
  const repo = getGitHubRepo();

  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));
    if (pkg.version && pkg.version !== 'dev') {
      const tag = `v${pkg.version}`;
      return {
        version: tag,
        url: `https://github.com/${repo}/releases/tag/${tag}`,
        label: 'Release',
      };
    }
  } catch {
    // Fall through
  }

  try {
    const tag = execSync('git describe --tags --exact-match HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {
      version: tag,
      url: `https://github.com/${repo}/releases/tag/${tag}`,
      label: 'Release',
    };
  } catch {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    return {
      version: commit,
      url: `https://github.com/${repo}/commit/${commit}`,
      label: 'Commit',
    };
  }
}

const gitInfo = getGitInfo();
const buildTimestamp = new Date().toISOString();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

// Read source files
const readmeContent = readFileSync(join(ROOT_DIR, 'README.md'), 'utf-8');
const githubMarkdownCss = readFileSync(
  join(ROOT_DIR, 'node_modules/github-markdown-css/github-markdown.css'),
  'utf-8'
);
const highlightLightCss = readFileSync(
  join(ROOT_DIR, 'node_modules/highlight.js/styles/github.min.css'),
  'utf-8'
);
const highlightDarkCss = readFileSync(
  join(ROOT_DIR, 'node_modules/highlight.js/styles/github-dark.min.css'),
  'utf-8'
);

/**
 * Purge unused CSS selectors and minify the result
 */
async function optimizeCSS(css: string, html: string): Promise<string> {
  // Purge unused selectors - no safelist needed since all rendering
  // (markdown, syntax highlighting) happens at build time
  const purged = await new PurgeCSS().purge({
    content: [{ raw: html, extension: 'html' }],
    css: [{ raw: css }],
  });

  const purgedCss = purged[0]?.css || css;

  // Minify with cssnano
  const minified = await postcss([cssnano({ preset: 'default' })]).process(purgedCss, {
    from: undefined,
  });

  return minified.css;
}

// Apply placeholders to README content
// Replace reprox.dev URLs with {{BASE_URL}} placeholder
let processedMarkdown = readmeContent.replace(/https:\/\/reprox\.dev/g, '{{BASE_URL}}');

// Replace fingerprint verification comment text with placeholder, keeping the
// leading "# " so hljs wraps it in <span class="hljs-comment"> at build time
processedMarkdown = processedMarkdown.replace(
  /# Verify the instance's fingerprint by browsing to it in your web browser/g,
  '# {{FINGERPRINT_COMMENT}}'
);

// Configure marked with plugins and syntax highlighting
marked.use(gfmHeadingId());
marked.use(markedAlert());
marked.use({
  renderer: {
    code(token) {
      const lang = token.lang || '';
      const code = token.text;

      // Apply syntax highlighting for bash
      if (lang === 'bash' && hljs.getLanguage('bash')) {
        const highlighted = hljs.highlight(code, { language: 'bash' }).value;
        return `<pre><code class="hljs language-bash">${highlighted}</code></pre>`;
      }

      // Fallback for other languages (escape HTML)
      const escaped = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${escaped}</code></pre>`;
    },
  },
});

// Render markdown to HTML
const renderedContent = marked.parse(processedMarkdown) as string;

// Search box component injected after the Usage heading
const searchBoxHtml = `<div class="reprox-search" id="reprox-search">
  <label class="reprox-search-label" for="reprox-search-input">Try it &mdash; search for a GitHub repository to fill in the commands below:</label>
  <div class="reprox-search-wrap">
    <input class="reprox-search-input" id="reprox-search-input" type="text"
           placeholder="e.g. joshuar/go-hass-agent" autocomplete="off">
    <div class="reprox-search-results" id="reprox-search-results"></div>
  </div>
  <small class="reprox-search-status" id="reprox-search-status"></small>
  <div class="reprox-search-active" id="reprox-search-active"></div>
</div>`;

// Inject search box between Usage heading and first subsection
const finalContent = renderedContent.replace(
  /<h2 id="usage">Usage<\/h2>\n<h3/,
  `<h2 id="usage">Usage</h2>\n${searchBoxHtml}\n<h3`
);

if (finalContent === renderedContent) {
  throw new Error('Failed to inject search box — the Usage heading pattern was not found in rendered HTML');
}

// Client-side JavaScript for the search box
const clientScript = `<script>
(function(){
  var input=document.getElementById('reprox-search-input');
  var results=document.getElementById('reprox-search-results');
  var status=document.getElementById('reprox-search-status');
  var banner=document.getElementById('reprox-search-active');
  var content=document.getElementById('content');
  var originals=[];
  var hidden=[];
  var timer=null;
  var selIdx=-1;
  var items=[];
  var pickGen=0;

  input.addEventListener('input',function(){
    clearTimeout(timer);
    var q=this.value.trim();
    if(q.length<2){hideResults();status.textContent='';return;}
    status.textContent='Searching\\u2026';
    timer=setTimeout(function(){doSearch(q);},300);
  });

  input.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'&&items.length){e.preventDefault();selIdx=Math.min(selIdx+1,items.length-1);highlight();}
    else if(e.key==='ArrowUp'&&items.length){e.preventDefault();selIdx=Math.max(selIdx-1,-1);highlight();}
    else if(e.key==='Enter'&&selIdx>=0){e.preventDefault();pick(items[selIdx]);}
    else if(e.key==='Escape'){hideResults();}
  });

  document.addEventListener('click',function(e){
    if(!e.target.closest('.reprox-search'))hideResults();
  });

  function doSearch(q){
    fetch('/_/search?q='+encodeURIComponent(q))
      .then(function(r){
        if(r.status===403){status.textContent='Rate limited \\u2014 please wait a moment.';return;}
        if(!r.ok){status.textContent='Search failed.';return;}
        return r.json();
      })
      .then(function(data){
        if(!data)return;
        items=data.items||[];
        selIdx=-1;
        if(!items.length){status.textContent='No repositories found.';hideResults();return;}
        status.textContent=items.length+' results';
        render();
      })
      .catch(function(){status.textContent='Search failed.';});
  }

  function render(){
    results.innerHTML=items.map(function(r,i){
      var stars=r.stargazers_count||0;
      var desc=r.description?'<small class="reprox-search-item-desc">'+esc(r.description)+'</small>':'';
      return '<div class="reprox-search-item" data-i="'+i+'"><div class="reprox-search-item-name"><strong>'+esc(r.full_name)+
        '</strong> <span style="color:var(--fgColor-muted,#59636e)">('+stars.toLocaleString()+' stars)</span></div>'+desc+'</div>';
    }).join('');
    results.querySelectorAll('.reprox-search-item').forEach(function(el){
      el.addEventListener('click',function(){pick(items[+this.dataset.i]);});
    });
    results.classList.add('active');
  }

  function highlight(){
    results.querySelectorAll('.reprox-search-item').forEach(function(el,i){
      el.classList.toggle('selected',i===selIdx);
      if(i===selIdx)el.scrollIntoView({block:'nearest'});
    });
  }

  function hideResults(){results.classList.remove('active');selIdx=-1;}

  function pick(repo){
    hideResults();
    var gen=++pickGen;
    var parts=repo.full_name.split('/');
    var owner=parts[0],rname=parts[1],pkg=rname;
    replacePlaceholders(owner,rname,pkg);
    input.value=repo.full_name;
    showBanner(owner,rname,pkg);
    status.textContent='';

    fetch('/_/package?owner='+encodeURIComponent(owner)+'&repo='+encodeURIComponent(rname))
      .then(function(r){return r.ok?r.json():null;})
      .then(function(data){
        if(!data||gen!==pickGen)return;
        if(data.package&&data.package!==rname){
          pkg=data.package;
          replacePlaceholders(owner,rname,pkg);
          showBanner(owner,rname,pkg);
        }
        if(!data.hasPackages){
          status.textContent='Note: This repo\\u2019s latest release has no .deb or .rpm assets.';
        }
      })
      .catch(function(){});
  }

  function showBanner(owner,rname,pkg){
    var pkgNote=pkg!==rname?' (package: <code>'+esc(pkg)+'</code>)':'';
    banner.innerHTML='Using <strong>'+esc(owner+'/'+rname)+'</strong>'+pkgNote+
      ' \\u2014 all commands below are ready to copy.'+
      '<a href="#" class="reprox-search-clear" id="reprox-clear">Reset</a>';
    banner.classList.add('visible');
    document.getElementById('reprox-clear').addEventListener('click',function(e){e.preventDefault();reset();});
  }

  function replacePlaceholders(owner,repo,pkg){
    restore();
    hideHints();
    var walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT,null);
    var node;
    while(node=walker.nextNode()){
      var t=node.textContent;
      if(t.indexOf('{owner}')!==-1||t.indexOf('{repo}')!==-1||t.indexOf('{package}')!==-1){
        originals.push({node:node,text:t});
        node.textContent=t.replace(/\\{owner\\}/g,owner).replace(/\\{repo\\}/g,repo).replace(/\\{package\\}/g,pkg);
      }
    }
  }

  function hideHints(){
    content.querySelectorAll('.hljs-comment').forEach(function(el){
      if(!el.textContent||el.textContent.indexOf('Replace {owner}')===-1)return;
      el.style.display='none';
      hidden.push({type:'style',node:el});
      trimNewline(el);
      var nextEl=el.nextElementSibling;
      if(nextEl&&nextEl.classList.contains('hljs-comment')&&nextEl.textContent.trim()==='#'){
        nextEl.style.display='none';
        hidden.push({type:'style',node:nextEl});
        trimNewline(nextEl);
      }
    });
  }

  function trimNewline(el){
    var next=el.nextSibling;
    if(next&&next.nodeType===3&&next.textContent.charAt(0)==='\\n'){
      hidden.push({type:'text',node:next,text:next.textContent});
      next.textContent=next.textContent.slice(1);
    }
  }

  function restore(){
    originals.forEach(function(o){o.node.textContent=o.text;});
    originals=[];
    hidden.forEach(function(h){
      if(h.type==='style')h.node.style.display='';
      else h.node.textContent=h.text;
    });
    hidden=[];
  }

  function reset(){
    restore();
    input.value='';
    banner.classList.remove('visible');
    banner.innerHTML='';
    status.textContent='';
  }

  function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
})();
<\/script>`;


// Custom CSS that's always needed
const customCss = `
  .markdown-body {
    box-sizing: border-box;
    min-width: 200px;
    max-width: 980px;
    margin: 0 auto;
    padding: 45px;
  }
  @media (max-width: 767px) {
    .markdown-body { padding: 15px; }
  }
  .site-footer {
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid #d1d9e0;
    text-align: center;
    font-size: 12px;
    color: #636c76;
  }
  .site-footer a { color: #636c76; }
  .site-footer a:hover { color: #0969da; }
  @media (prefers-color-scheme: dark) {
    .site-footer { border-color: #3d444d; color: #9198a1; }
    .site-footer a { color: #9198a1; }
    .site-footer a:hover { color: #4493f8; }
  }
  .reprox-search {
    border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
    background: var(--bgColor-muted, #f6f8fa);
  }
  .reprox-search-label {
    font-weight: var(--base-text-weight-semibold, 600);
    margin-bottom: 8px;
    display: block;
  }
  .reprox-search-wrap { position: relative; }
  .reprox-search-input {
    width: 100%;
    padding: 5px 12px;
    font-size: 14px;
    line-height: 20px;
    border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 6px;
    background: var(--bgColor-default, #fff);
    color: var(--fgColor-default, #1f2328);
    box-sizing: border-box;
    font-family: var(--fontStack-sansSerif);
  }
  .reprox-search-input:focus {
    border-color: var(--borderColor-accent-emphasis, #0969da);
    outline: none;
    box-shadow: 0 0 0 3px rgba(9,105,218,0.3);
  }
  .reprox-search-results {
    position: absolute;
    left: 0; right: 0;
    z-index: 10;
    border: 1px solid var(--borderColor-default, #d1d9e0);
    border-radius: 6px;
    margin-top: 4px;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bgColor-default, #fff);
    display: none;
  }
  .reprox-search-results.active { display: block; }
  .reprox-search-item {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3);
    font-size: 14px;
  }
  .reprox-search-item:last-child { border-bottom: none; }
  .reprox-search-item:hover,
  .reprox-search-item.selected {
    background: var(--bgColor-accent-muted, rgba(9,105,218,0.08));
  }
  .reprox-search-item-name {
    color: var(--fgColor-accent, #0969da);
  }
  .reprox-search-item-desc {
    color: var(--fgColor-muted, #59636e);
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reprox-search-status {
    color: var(--fgColor-muted, #59636e);
    display: block;
    padding: 4px 0 0;
    min-height: 16px;
  }
  .reprox-search-active {
    margin-top: 8px;
    padding: 8px 12px;
    background: var(--bgColor-attention-muted, #fff8c5);
    border-radius: 6px;
    font-size: 14px;
    display: none;
  }
  .reprox-search-active.visible { display: block; }
  .reprox-search-clear {
    margin-left: 8px;
    cursor: pointer;
    color: var(--fgColor-accent, #0969da);
    text-decoration: underline;
  }
  @media (prefers-color-scheme: dark) {
    .reprox-search-input:focus {
      box-shadow: 0 0 0 3px rgba(31,111,235,0.3);
    }
  }
`;

async function main() {
  // Build a temporary HTML structure for CSS purging (includes footer and search box for their styles)
  // finalContent already contains searchBoxHtml with all base classes; dynamicStateHint adds JS-toggled state classes so PurgeCSS retains them
  const dynamicStateHint = '<div class="reprox-search-results active"><div class="reprox-search-item selected"></div></div><div class="reprox-search-active visible"><a class="reprox-search-clear"></a></div>';
  const tempHtml = `<body class="markdown-body"><main>${finalContent}${dynamicStateHint}</main><footer class="site-footer"><a href="#">link</a></footer></body>`;

  // Optimize all CSS in parallel
  const [optimizedGithubCss, optimizedLightCss, optimizedDarkCss, optimizedCustomCss] =
    await Promise.all([
      optimizeCSS(githubMarkdownCss, tempHtml),
      optimizeCSS(highlightLightCss, tempHtml),
      optimizeCSS(highlightDarkCss, tempHtml),
      optimizeCSS(customCss, tempHtml),
    ]);

  // Log size savings
  const originalSize = githubMarkdownCss.length + highlightLightCss.length + highlightDarkCss.length + customCss.length;
  const optimizedSize = optimizedGithubCss.length + optimizedLightCss.length + optimizedDarkCss.length + optimizedCustomCss.length;
  console.log(`CSS optimized: ${(originalSize / 1024).toFixed(1)}KB → ${(optimizedSize / 1024).toFixed(1)}KB (${((1 - optimizedSize / originalSize) * 100).toFixed(0)}% reduction)`);

  // Build complete HTML document
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reprox - A Serverless Github Releases APT/RPM Gateway</title>
  <meta name="description" content="Turn Github Releases into an APT or RPM repository">
  <meta name="keywords" content="linux, software, reprox, github, releases, apt, rpm, repository">
  <meta property="og:url" content="{{BASE_URL}}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Reprox - A Serverless Github Releases APT/RPM Gateway">
  <meta property="og:description" content="Turn Github Releases into an APT or RPM repository">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${optimizedGithubCss}</style>
  <style media="(prefers-color-scheme: light)">${optimizedLightCss}</style>
  <style media="(prefers-color-scheme: dark)">${optimizedDarkCss}</style>
  <style>${optimizedCustomCss}</style>
</head>
<body class="markdown-body">
  <main id="content">
${finalContent}
  </main>
  <footer class="site-footer">
    <a href="${gitInfo.url}">${gitInfo.label} ${gitInfo.version}</a>
    · Built ${buildTimestamp}{{FINGERPRINT_FOOTER}}
  </footer>
${clientScript}
</body>
</html>`;

  // Generate TypeScript file with exported constants
  const output = `// Auto-generated by scripts/build-readme.ts - DO NOT EDIT
// Run 'npm run build:readme' to regenerate

export const README_HTML = ${JSON.stringify(html)};

export const README_MARKDOWN = ${JSON.stringify(processedMarkdown)};
`;

  // Ensure output directory exists
  const outputDir = join(ROOT_DIR, 'src/generated');
  mkdirSync(outputDir, { recursive: true });

  // Write output
  writeFileSync(join(outputDir, 'readme-html.ts'), output, 'utf-8');

  console.log('Generated src/generated/readme-html.ts');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
