# Shadowbook — read this first

Options-trading app: React/Vite client (`client/`), Express server (`server/`) on Railway, Supabase schema `options` (project `dqyjdxlixzzxxxsqjxfq`), and the IBKR TWS bridge (`bridge/`) on Vasa's Mac via ngrok.

## Master and subordinate sessions
- **The master session** is named in the project doc `claude/MASTER-SESSION.md` (read it with the Projects tool). It alone merges to `main`, deploys, runs Supabase migrations, edits live data and keeps the open-items list.
- **Every other session is a subordinate.** If that's you:
  - Work only on a feature branch started from the latest `origin/main`.
  - Never push to `main`, merge, deploy, run migrations or edit live data — even if it seems quicker.
  - When the work is done and Vasa is happy: push the branch, open a pull request (`gh pr create --base main`), add one line under "Handoffs" in `claude/MASTER-SESSION.md` (`date · session link · branch @ commit · PR # · what · tests run · bridge change? · DB change?`), and tell Vasa to say "merge <branch> and deploy" in the master.
  - Write durable findings to their own project doc.
- `main` only takes changes through pull requests. Railway deploys every push to `main`.

## Hard rules (every session)
- Staged TWS orders are always `transmit=false`.
- Never send a stop-loss to TWS — only the entry and the profit target. Vasa manages losses himself.
- Never enter passwords; Vasa logs into the IBKR Portal himself.
- TWS is read-only for computer use: never click, type or script in it.

## Working
- Tests: `cd client && npx vitest run`. Build: `cd client && npx vite build`. Both must pass before a handoff.
- Show mock-ups or screenshots for anything visual and iterate before handing off.
- A change under `bridge/` only takes effect after the Mac runs `cd ~/Options-Tracker && git pull` and restarts the bridge (`launchctl unload` / `load ~/Library/LaunchAgents/com.options-tracker.ib-bridge.plist`). Say so in the handoff.
- Big shared files (`client/src/components/EnginePanel.jsx`, `client/src/components/VisionDashboard.jsx`, `client/src/styles/vision.css`): if another open branch touches the same file, flag it in the handoff so the master merges one before the other.
- Commits end with the session's `Co-Authored-By` / `Claude-Session` trailers.
