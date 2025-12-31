# Reprox 📦

## What is this?

Want to distribute your software via `apt` or `dnf` without maintaining your own repository infrastructure? [Reprox](https://reprox.dev) turns any GitHub Release into a fully compliant APT or RPM repository on-the-fly. Just upload `.deb` or `.rpm` files to your GitHub Release and point your users at `reprox.dev/{owner}/{repo}`.

### Features

- 🚀 Instant repository from any GitHub Release - no setup required
- 📦 Supports both APT (Debian/Ubuntu) and RPM (Fedora/RHEL/CentOS)
- ⚡ Fast metadata generation via [Range Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests)
- 🔐 GPG-signed repositories for secure package verification
- ↗️ Package downloads redirect straight to GitHub's CDN

## Usage

### APT (Debian/Ubuntu)

```bash
# Import the signing key
curl -fsSL https://reprox.dev/{owner}/{repo}/public.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/{repo}.gpg

# Add the repository
echo "deb [signed-by=/etc/apt/keyrings/{repo}.gpg] https://reprox.dev/{owner}/{repo} stable main" | \
  sudo tee /etc/apt/sources.list.d/{repo}.list

# Install
sudo apt update && sudo apt install {package}
```

### RPM (Fedora/RHEL/CentOS)

```bash
sudo tee /etc/yum.repos.d/{repo}.repo << EOF
[{repo}]
name={repo} from GitHub via Reprox
baseurl=https://reprox.dev/{owner}/{repo}
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=https://reprox.dev/{owner}/{repo}/public.key
EOF

sudo dnf install {package}
```

Note: `gpgcheck=0` disables individual package signature verification because Reprox redirects downloads to GitHub without re-signing. Package integrity is still verified via checksums in the signed repository metadata (`repo_gpgcheck=1`).

Replace `{owner}`, `{repo}`, and `{package}` with your GitHub repository details and package name.

## Self-Hosting

Run your own instance on Cloudflare Workers:

### Prerequisites

- Node.js 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- GPG (for generating signing keys)

### Quick Start

```bash
# Clone and install
git clone https://github.com/leoherzog/reprox.git && cd reprox && npm install

# Login to Cloudflare
npx wrangler login

# Generate and add a signing key
gpg --quick-gen-key "Reprox" rsa4096 sign never
gpg --armor --export-secret-keys "Reprox" | npx wrangler secret put GPG_PRIVATE_KEY

# Optional: if using a GPG key that has a passphrase
npx wrangler secret put GPG_PASSPHRASE

# Optional: add GitHub token for higher rate limits (60 → 5,000 req/hr)
npx wrangler secret put GITHUB_TOKEN

# Deploy
npm run deploy
```

### Configuration

**Secrets** (set via `npx wrangler secret put <NAME>`):

| Secret | Description |
|--------|-------------|
| `GPG_PRIVATE_KEY` | ASCII-armored GPG private key for signing (recommended) |
| `GPG_PASSPHRASE` | Passphrase if your GPG key is encrypted |
| `GITHUB_TOKEN` | GitHub PAT for higher API rate limits |

**Environment Variables** (set in `wrangler.toml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL` | `86400` | Cache TTL in seconds (24 hours) |

### Custom Domain

Add a custom domain via Cloudflare dashboard (Workers → Triggers → Custom Domains) or in `wrangler.toml`:

```toml
routes = [
  { pattern = "packages.example.com/*", zone_name = "example.com" }
]
```

### Updating

```bash
git pull && npm install && npm run deploy
```

## License

The MIT License (MIT)

Copyright © 2025 Leo Herzog

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## About Me

<a href="https://herzog.tech/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/link-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/link.svg.png">
    <img src="https://herzog.tech/signature/link.svg.png" width="32px">
  </picture>
</a>
<a href="https://mastodon.social/@herzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mastodon-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mastodon.svg.png">
    <img src="https://herzog.tech/signature/mastodon.svg.png" width="32px">
  </picture>
</a>
<a href="https://github.com/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/github-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/github.svg.png">
    <img src="https://herzog.tech/signature/github.svg.png" width="32px">
  </picture>
</a>
<a href="https://keybase.io/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/keybase-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/keybase.svg.png">
    <img src="https://herzog.tech/signature/keybase.svg.png" width="32px">
  </picture>
</a>
<a href="https://www.linkedin.com/in/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/linkedin-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/linkedin.svg.png">
    <img src="https://herzog.tech/signature/linkedin.svg.png" width="32px">
  </picture>
</a>
<a href="https://hope.edu/directory/people/herzog-leo/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/anchor-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/anchor.svg.png">
    <img src="https://herzog.tech/signature/anchor.svg.png" width="32px">
  </picture>
</a>
<br />
<a href="https://herzog.tech/$" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png">
    <img src="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png" alt="Buy Me A Tea" width="32px">
  </picture>
  Found this helpful? Buy me a tea!
</a>
