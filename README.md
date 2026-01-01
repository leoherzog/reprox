# 📦 Reprox — A Serverless Github Releases APT/RPM Gateway
https://github.com/leoherzog/reprox

There are many great Linux softwares that distribute .deb and/or .rpm packages via Github Releases only. Reprox turns any GitHub repository that uses Releases into a fully compliant APT or COPR repository. Package downloads redirect straight to GitHub's CDN, moving the trust model from the maintainer of an APT/COPR repository to the maintainer of the GitHub repository.

I made this for my own personal use, so I didn't have to "Watch" for new Github Releases and manually download/install updates. I recognize that I am man-in-the-middling the traditional trust model for package repositories. Be careful to add only trusted, official upstream Github repositories. If you're worried about me man-in-the-middleing you, skip ahead to [the Self-Hosting section](#self-hosting).

Supports all Releases since [June 2025](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/). Older releases will not appear in the package repository.

## Usage

### APT (Debian/Ubuntu)

```bash
# Replace {owner}, {repo}, and {package} with the Github repository and package name

# Optional: verify the key fingerprint before importing
curl -fsSL https://reprox.dev/{owner}/{repo}/public.key | gpg --show-keys
# Verify the instance's fingerprint by browsing to it in your web browser

# Import the signing key
curl -fsSL https://reprox.dev/{owner}/{repo}/public.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/{repo}.gpg

echo "deb [signed-by=/etc/apt/keyrings/{repo}.gpg] https://reprox.dev/{owner}/{repo} stable main" | \
  sudo tee /etc/apt/sources.list.d/{repo}.list

# Install
sudo apt update && sudo apt install {package}
```

### RPM (Fedora/RHEL/CentOS)

```bash
# Replace {owner}, {repo}, and {package} with the Github repository and package name
# 
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
# Optional: verify the key fingerprint on first update/install
# Verify the instance's fingerprint by browsing to it in your web browser
```
> [!NOTE]
> `gpgcheck=0` disables individual package signature verification because Reprox redirects downloads to GitHub without re-signing. Package integrity is still verified via checksums in the signed repository metadata (`repo_gpgcheck=1`).

## Self-Hosting

Feel free to use my instance at reprox.dev, or run your own instance on Cloudflare Workers:

### Prerequisites

- Node.js 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- GPG (for generating signing keys)

### Quick Start

```bash
# Clone and install
git clone git@github.com:leoherzog/reprox.git && cd reprox && npm install

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

To update, `fetch` and `checkout` the latest tagged Release:
```bash
# git clone git@github.com:leoherzog/reprox.git
git fetch --tags && git checkout $(git tag --sort=-version:refname | head -n1) && npm install && npm run deploy
```

## About Me

♥ [Leo Herzog](https://herzog.tech)

[🍵 Buy me a tea!](https://herzog.tech/$)
