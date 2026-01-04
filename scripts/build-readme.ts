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
 * Get git version info - prefer release tag, fallback to commit hash
 */
function getGitInfo(): { version: string; url: string; label: string } {
  const repo = getGitHubRepo();

  // Try to get tag if HEAD is exactly tagged
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
    // Fall back to short commit hash
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

// Replace fingerprint verification comment with placeholder
processedMarkdown = processedMarkdown.replace(
  /# Verify the instance's fingerprint by browsing to it in your web browser/g,
  '{{FINGERPRINT_COMMENT}}'
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
`;

async function main() {
  // Build a temporary HTML structure for CSS purging (includes footer for its styles)
  const tempHtml = `<body class="markdown-body"><main>${renderedContent}</main><footer class="site-footer"><a href="#">link</a></footer></body>`;

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
  <meta name="description" content="Turn Github Releases into an APT or COPR repository">
  <meta name="keywords" content="linux, software, reprox, github, releases, apt, copr, repository">
  <meta property="og:url" content="{{BASE_URL}}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Reprox - A Serverless Github Releases APT/RPM Gateway">
  <meta property="og:description" content="Turn Github Releases into an APT or COPR repository">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${optimizedGithubCss}</style>
  <style media="(prefers-color-scheme: light)">${optimizedLightCss}</style>
  <style media="(prefers-color-scheme: dark)">${optimizedDarkCss}</style>
  <style>${optimizedCustomCss}</style>
</head>
<body class="markdown-body">
  <main id="content">
${renderedContent}
  </main>
  <footer class="site-footer">
    <a href="${gitInfo.url}">${gitInfo.label} ${gitInfo.version}</a>
    · Built ${buildTimestamp}{{FINGERPRINT_FOOTER}}
  </footer>
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
