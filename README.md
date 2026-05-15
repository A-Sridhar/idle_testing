# SSH Monitor UI

Web app to monitor multiple systems over SSH and collect PMUtil and Turbostat data on a timed schedule.

## Features
- Dynamic system count input (numeric up/down)
- Per-system setup: system name, IP, SSH username/password, idle time, monitor duration
- Per-system Monitor and Stop controls
- Per-system live output page (opens in a new window)
- Active-only summary table in main UI:
  - System name, IP, sockets (from PMUtil), C6 and PC6 (from Turbostat), elapsed, time left
- Real-time SSH failure and recovery status in Active Summary
- SSH reattempt count in Active Summary and Summary
- Logs saved as text files under repo-local `logs/` (or custom `LOGS_DIR`)

## Stack
- Node.js + Express backend
- WebSocket live updates
- Vanilla HTML/CSS/JavaScript frontend
- SSH execution via `ssh2`

## Setup
1. Install dependencies:
   ```powershell
   npm install
   ```
2. Configure environment (portable option):
   - Copy `.env.example` to `.env` and fill values, or set env vars in your shell.
   ```powershell
   Copy-Item .env.example .env
   ```
3. Start in development mode:
   ```powershell
   npm run dev
   ```
   or start normally:
   ```powershell
   npm start
   ```
4. Open:
   ```
   http://localhost
   ```

## Portable Configuration
You can run this app on any system by setting environment variables instead of editing code.

- `PORT` (default: `80`)
- `HOST` (default: `0.0.0.0` for LAN access)
- `LOGS_DIR` (default: `logs` inside repo)
- `SSH_USERNAME` (optional global fallback when per-system value is blank)
- `SSH_PASSWORD` (optional global fallback when per-system value is blank)
- `DEFAULT_PMUTIL_COMMAND` (optional)
- `DEFAULT_TURBOSTAT_COMMAND` (optional)

PowerShell example:
```powershell
$env:PORT = "8080"
$env:HOST = "0.0.0.0"
$env:LOGS_DIR = "logs"
$env:SSH_USERNAME = "myuser"
$env:SSH_PASSWORD = "mypassword"
npm start
```

Linux/macOS example:
```bash
PORT=8080 HOST=0.0.0.0 LOGS_DIR=logs SSH_USERNAME=myuser SSH_PASSWORD=mypassword npm start
```

## Configuration Notes
- Default PMUtil command used when not overridden by `DEFAULT_PMUTIL_COMMAND`:
   - `cd /root/apps/PI_PM/pmutil && ./pmutil_bin -i`
- Default Turbostat command used when not overridden by `DEFAULT_TURBOSTAT_COMMAND`:
   - `cd /root/apps/PI_PM/turbostat && ./turbostat -q -s Package,Node,Core,CPU,Bzy_MHz,IPC,Busy%,CPU%c1,CPU%c6,C1E%,CoreTmp,PkgTmp,Pkg%pc2,Pkg%pc6,PkgWatt,RAMWatt,UncMHz,Mod%c6 -interval 1 -n 5`
- Backend uses password authentication over SSH.
- Per-system SSH username/password can be entered in each card.
- If both per-system SSH credentials and env vars are blank, monitor start is blocked with a clear error.
- App binds to `HOST`; use your machine IP plus `PORT` to open UI from other systems on the same network.
- Ensure OS firewall allows inbound access to selected `PORT`.
- Idle time controls data collection interval.
- Monitor duration controls total run time per system.

## API Endpoints
- `GET /health`
- `GET /api/systems`
- `GET /api/systems/active`
- `POST /api/systems`
- `POST /api/systems/:id/start`
- `POST /api/systems/:id/stop`
- `GET /api/systems/:id/details`
- `GET /api/systems/:id/log`
