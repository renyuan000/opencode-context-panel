# Publish checklist

This package is free and MIT licensed. Sponsorship is optional; see `README.md`.

## 1. Before publishing

- [x] Add your Alipay QR code as `assets/alipay.png` (542x572 PNG, present).
- [ ] Optional: add Ko-fi / PayPal links for overseas sponsors and update `README.md`.
- [ ] Confirm the repository name. The metadata currently assumes:
      `https://github.com/renyuan000/opencode-context-panel`
- [x] Run `npm run typecheck`.
- [x] Run `npm pack --dry-run` and confirm the tarball contains `src/tui.tsx`, `README.md`, `LICENSE`, `package.json`, `assets/alipay.png`.

## 2. Create the GitHub repository

The GitHub CLI needs direct access to GitHub from this VM. If `gh` times out, bypass the WSL proxy for GitHub:

```bash
export NO_PROXY=github.com,api.github.com
export no_proxy=github.com,api.github.com
gh auth status
```

Then create and push:

```bash
cd /root/.config/opencode/packages/opencode-context-panel
git init
git add .
git commit -m "feat: initial opencode context panel plugin"
gh repo create renyuan000/opencode-context-panel --public --source=. --remote=origin --push
```

Do not commit `node_modules`, tarballs, or local backup files.

## 3. Publish to npm

```bash
npm login
npm whoami
npm publish
```

For an unscoped package, `npm publish` publishes publicly. Verify before running; npm publishes are not easily reversible.

After publishing:

```bash
npm view opencode-context-panel version
opencode plugin opencode-context-panel -g
```

Restart OpenCode and verify the sidebar and `/context`.

## 4. After publishing

- [ ] Add the npm install command and repository link to the README.
- [ ] Open a GitHub release/tag matching the npm version.
- [ ] Test install in a clean config directory.
- [ ] Keep the local wrapper `~/.config/opencode/plugins/tui-context-panel.tsx` pointing at the package source, or switch it to the npm package.
