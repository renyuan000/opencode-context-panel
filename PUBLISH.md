# Publish checklist

This package is free and MIT licensed. Sponsorship is optional; see `README.md`.

> npm publishing is currently blocked by npm's anti-bot/Cloudflare checks. GitHub is the supported distribution path; see the manual install section in `README.md`. Do not advertise an npm install command until publishing actually succeeds.

## 1. Before publishing

- [x] Add your Alipay QR code as `assets/alipay.png` (542x572 PNG, present).
- [ ] Optional: add Ko-fi / PayPal links for overseas sponsors and update `README.md`.
- [x] Confirm the repository name: `https://github.com/renyuan000/opencode-context-panel`
- [x] Run `npm run typecheck`.
- [x] Run `npm pack --dry-run` and confirm the tarball contains `src/tui.tsx`, `install.sh`, `README.md`, `LICENSE`, `package.json`, `assets/alipay.png`.

## 2. GitHub repository

Already created and pushed:

```bash
export NO_PROXY=github.com,api.github.com
git remote -v
git log --oneline -3
```

## 3. npm (blocked)

Only run this after `npm whoami` succeeds and the account is not blocked:

```bash
npm adduser --registry=https://registry.npmjs.org/
npm login --auth-type=legacy
npm whoami
npm publish
```

If npm still reports bot/unusual activity, do not keep retrying. Use a normal network (phone hotspot, no VPN), or wait 24 hours. Until then, keep the README on manual GitHub install.

## 4. After a successful npm publish

- [ ] Verify `npm view opencode-context-panel version`.
- [ ] Add the npm install command to the README only after verification.
- [ ] Test a clean global install and restart OpenCode.
- [ ] Open a GitHub release/tag matching the npm version.
- [ ] Keep the local wrapper `~/.config/opencode/plugins/tui-context-panel.tsx` pointing at the package source, or switch it to the npm package.
