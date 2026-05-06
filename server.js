const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { WebSocketServer } = require("ws");
const { Client } = require("ssh2");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const logsDir = path.join(__dirname, "logs");

const DEFAULT_COMMANDS = {
  pmutil: process.env.DEFAULT_PMUTIL_COMMAND || "cd /root/apps/PI_PM/pmutil && ./pmutil_bin -i",
  turbostat:
    process.env.DEFAULT_TURBOSTAT_COMMAND ||
    "cd /root/apps/PI_PM/turbostat && ./turbostat -q -s Package,Node,Core,CPU,Bzy_MHz,IPC,Busy%,CPU%c1,CPU%c6,C1E%,CoreTmp,PkgTmp,Pkg%pc2,Pkg%pc6,PkgWatt,RAMWatt,UncMHz,Mod%c6 -interval 1 -n 5"
};

const DEFAULT_SSH_USERNAME = process.env.SSH_USERNAME || "";
const DEFAULT_SSH_PASSWORD = process.env.SSH_PASSWORD || "";
const SSH_READY_TIMEOUT_MS = 10000;
const SSH_COMMAND_TIMEOUT_MS = 15000;
const SSH_RECOVERY_RETRY_MS = 1000;
const SSH_HEARTBEAT_INTERVAL_MS = 5000;
const SSH_REATTEMPT_COUNT_THRESHOLD_MS = 10000;

const systems = new Map();
const wsClients = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function sanitizeFileSegment(input) {
  return String(input || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseSockets(pmutilOutput) {
  const text = pmutilOutput || "";
  const socketMatches = text.match(/socket[s]?\s*[:=]?\s*([0-9]+)/i);
  if (socketMatches && socketMatches[1]) {
    return Number(socketMatches[1]);
  }
  const grepMatches = text.match(/socket/gi);
  if (grepMatches) {
    return grepMatches.length;
  }
  return null;
}

function parseTurboStat(turbostatOutput) {
  const text = turbostatOutput || "";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let c6 = null;
  let pc6 = null;

  // Parse the tabular turbostat output by locating CPU%c6 and Pkg%pc6 columns.
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    if (!header.includes("CPU%c6") || !header.includes("Pkg%pc6")) {
      continue;
    }

    const headers = header.split(/\s+/);
    const cpuC6Idx = headers.indexOf("CPU%c6");
    const pkgPc6Idx = headers.indexOf("Pkg%pc6");
    if (cpuC6Idx < 0 || pkgPc6Idx < 0) {
      continue;
    }

    let selectedData = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const row = lines[j];
      if (row.includes("CPU%c6") && row.includes("Pkg%pc6")) {
        break;
      }
      const cols = row.split(/\s+/);
      if (cols.length <= Math.max(cpuC6Idx, pkgPc6Idx)) {
        continue;
      }

      const cpuVal = Number(cols[cpuC6Idx]);
      const pkgVal = Number(cols[pkgPc6Idx]);
      if (!Number.isNaN(cpuVal) || !Number.isNaN(pkgVal)) {
        selectedData = {
          c6: Number.isNaN(cpuVal) ? null : cpuVal,
          pc6: Number.isNaN(pkgVal) ? null : pkgVal
        };
      }
    }

    if (selectedData) {
      c6 = selectedData.c6;
      pc6 = selectedData.pc6;
      break;
    }
  }

  if (c6 === null) {
    const c6Match = text.match(/CPU%c6[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
    c6 = c6Match ? Number(c6Match[1]) : null;
  }

  if (pc6 === null) {
    const pc6Match = text.match(/Pkg%pc6[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
    pc6 = pc6Match ? Number(pc6Match[1]) : null;
  }

  return {
    c6,
    pc6
  };
}

function toSummaryView(system) {
  const endTime = system.endedAt || Date.now();
  const elapsedMs = system.startedAt ? endTime - system.startedAt : 0;
  
  // Calculate pause time: accumulated pauses + current pause if SSH is failing
  let totalPauseMs = system.totalPausedMs || 0;
  if (system.sshFailureSince) {
    const currentPauseMs = Date.now() - system.sshFailureSince;
    totalPauseMs += currentPauseMs;
  }
  
  // Adjusted elapsed excludes pause time
  const adjustedElapsedMs = Math.max(0, elapsedMs - totalPauseMs);
  const elapsedSec = Math.max(0, Math.floor(adjustedElapsedMs / 1000));
  const leftSec = Math.max(0, system.monitorDurationSec - elapsedSec);
  const sshWaitSec = system.sshFailureSince
    ? Math.max(0, Math.floor((Date.now() - system.sshFailureSince) / 1000))
    : 0;

  // Clear recovery display if window has expired
  const showRecoveryMessage = system.sshRecoveryDisplayUntil && Date.now() < system.sshRecoveryDisplayUntil;
  if (!showRecoveryMessage && system.sshRecoveryDisplayUntil) {
    system.sshRecoveredAt = null;
    system.sshRecoveryDisplayUntil = null;
  }

  return {
    id: system.id,
    systemName: system.systemName,
    ip: system.ip,
    status: system.status,
    sockets: system.lastParsed.sockets,
    c6: system.lastParsed.c6,
    pc6: system.lastParsed.pc6,
    loopCount: Number(system.loopCount) || 0,
    targetRuns: Number(system.targetRuns) || 0,
    startedAt: system.startedAt,
    endedAt: system.endedAt,
    startDateTime: system.startedAt ? new Date(system.startedAt).toISOString() : null,
    endDateTime: system.endedAt ? new Date(system.endedAt).toISOString() : null,
    sshFailed: Boolean(system.sshFailureSince),
    sshWaitSec,
    sshWarningText: system.lastSshError || null,
    sshReattemptCount: Number(system.sshReattemptCount) || 0,
    lastReconnectSec: system.lastReconnectSec,
    lastConnectMs: system.lastConnectMs,
    sshRecoveredAt: showRecoveryMessage ? system.sshRecoveredAt : null,
    elapsedSec,
    leftSec,
    logPath: system.logPath,
    error: system.error,
    idleTimeSec: system.idleTimeSec,
    monitorDurationSec: system.monitorDurationSec
  };
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

async function ensureLogsDir() {
  await fsp.mkdir(logsDir, { recursive: true });
}

async function appendLog(logPath, blockTitle, text) {
  const stamp = new Date().toISOString();
  const block = `\n[${stamp}] ${blockTitle}\n${text || ""}\n`;
  await fsp.appendFile(logPath, block, "utf8");
}

function executeCommandOverSsh(conn, command, timeoutMs = SSH_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        stream.close();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      stream.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (code && code !== 0 && stderr) {
          reject(new Error(stderr.trim()));
          return;
        }
        resolve(stdout.trim());
      });

      stream.on("data", (data) => {
        stdout += String(data);
      });

      stream.stderr.on("data", (data) => {
        stderr += String(data);
      });

      stream.on("error", (streamErr) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(streamErr);
      });
    });
  });
}

function connectSsh(system) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const start = Date.now();

    conn
      .on("ready", () => resolve({ conn, connectMs: Date.now() - start }))
      .on("error", (err) => {
        reject(err);
      })
      .connect({
        host: system.ip,
        port: system.sshPort,
        username: system.username || DEFAULT_SSH_USERNAME,
        password: system.password || DEFAULT_SSH_PASSWORD,
        readyTimeout: SSH_READY_TIMEOUT_MS
      });
  });
}

function resolveSshCredentials(systemLike) {
  const username = String(systemLike?.username || DEFAULT_SSH_USERNAME || "").trim();
  const password = String(systemLike?.password || DEFAULT_SSH_PASSWORD || "");
  return { username, password };
}

function markSshRecovered(system) {
  if (!system.sshFailureSince) {
    system.error = null;
    system.lastSshError = null;
    return;
  }

  const pauseDurationMs = Date.now() - system.sshFailureSince;
  system.lastReconnectSec = Math.max(0, Math.floor(pauseDurationMs / 1000));
  system.totalPausedMs = (system.totalPausedMs || 0) + pauseDurationMs;
  if (pauseDurationMs > SSH_REATTEMPT_COUNT_THRESHOLD_MS) {
    system.sshReattemptCount = (Number(system.sshReattemptCount) || 0) + 1;
  }
  system.sshRecoveredAt = Date.now();
  system.sshRecoveryDisplayUntil = Date.now() + 8000;
  system.sshFailureSince = null;
  system.error = null;
  system.lastSshError = null;
  console.log(`[SSH RECOVERED] System: ${system.systemName} - Recovery time: ${system.lastReconnectSec}s, Total paused: ${system.totalPausedMs}ms`);
}

async function probeSshRecovery(system) {
  const ssh = await connectSsh(system);
  const conn = ssh.conn;
  try {
    system.lastConnectMs = ssh.connectMs;
    markSshRecovered(system);
  } finally {
    conn.end();
  }
}

async function heartbeatSsh(system) {
  if (
    system.status !== "running" ||
    system.sshFailureSince ||
    system.sshCheckInFlight ||
    system.collectionInFlight
  ) {
    return;
  }

  const now = Date.now();
  if (system.lastHeartbeatAt && now - system.lastHeartbeatAt < SSH_HEARTBEAT_INTERVAL_MS) {
    return;
  }

  system.lastHeartbeatAt = now;
  system.sshCheckInFlight = true;
  try {
    const ssh = await connectSsh(system);
    system.lastConnectMs = ssh.connectMs;
    ssh.conn.end();
  } catch (err) {
    if (!system.sshFailureSince) {
      system.sshFailureSince = Date.now();
      system.error = "SSH connection failed";
      system.lastSshError = String(err?.message || err || "SSH error").replace(/\s+/g, " ").trim();
      console.warn(`[SSH HEARTBEAT FAILURE] System: ${system.systemName} (${system.ip}) - Error: ${err.message}`);
      try {
        await appendLog(system.logPath, "ERROR", `HEARTBEAT: ${err.stack || String(err)}`);
      } catch (_logErr) {
        // best effort logging
      }
      broadcast({ type: "systemUpdate", system: toSummaryView(system) });
    }
  } finally {
    system.sshCheckInFlight = false;
  }
}

async function collectOnce(system, loopNumber) {
  const ssh = await connectSsh(system);
  const conn = ssh.conn;
  try {
    system.lastConnectMs = ssh.connectMs;
    markSshRecovered(system);

    const pmutilOutput = await executeCommandOverSsh(conn, system.pmutilCommand);
    const turbostatOutput = await executeCommandOverSsh(conn, system.turbostatCommand);

    const parsedTurbo = parseTurboStat(turbostatOutput);
    system.lastPmutil = pmutilOutput;
    system.lastTurbostat = turbostatOutput;
    system.lastParsed = {
      sockets: parseSockets(pmutilOutput),
      c6: parsedTurbo.c6,
      pc6: parsedTurbo.pc6
    };

    await appendLog(system.logPath, `LOOP_${loopNumber}_PMUTIL`, pmutilOutput);
    await appendLog(system.logPath, `LOOP_${loopNumber}_TURBOSTAT`, turbostatOutput);

    broadcast({ type: "systemUpdate", system: toSummaryView(system) });
    broadcast({
      type: "systemOutput",
      id: system.id,
      loopNumber,
      pmutilOutput,
      turbostatOutput,
      at: new Date().toISOString()
    });
  } finally {
    conn.end();
  }
}

function stopMonitoring(system, status, errorMessage) {
  if (system.timer) {
    clearTimeout(system.timer);
    system.timer = null;
  }
  system.collectionInFlight = false;
  system.status = status;
  system.error = errorMessage || null;
  if (status !== "running") {
    system.endedAt = Date.now();
  }
  broadcast({ type: "systemUpdate", system: toSummaryView(system) });
}

async function startMonitoring(system) {
  if (system.status === "running") {
    return;
  }

  const idleSec = Math.max(1, Number(system.idleTimeSec) || 1);
  const durationSec = Math.max(1, Number(system.monitorDurationSec) || 1);
  const targetRuns = Math.floor(durationSec / idleSec);

  if (targetRuns < 1) {
    stopMonitoring(system, "completed", null);
    return;
  }

  system.status = "running";
  system.error = null;
  system.startedAt = Date.now();
  system.endedAt = null;
  system.loopCount = 0;
  system.targetRuns = targetRuns;
  system.sshFailureSince = null;
  system.lastReconnectSec = null;
  system.lastConnectMs = null;
  system.sshRecoveredAt = null;
  system.sshRecoveryDisplayUntil = null;
  system.totalPausedMs = 0;
  system.sshReattemptCount = 0;
  system.lastSshError = null;
  system.sshCheckInFlight = false;
  system.lastHeartbeatAt = null;
  system.collectionInFlight = false;
  broadcast({ type: "systemUpdate", system: toSummaryView(system) });

  const scheduleNextRun = () => {
    if (system.status !== "running") {
      return;
    }

    if (system.loopCount >= system.targetRuns && !system.sshFailureSince) {
      stopMonitoring(system, "completed", null);
      return;
    }

    const isRecoveryMode = Boolean(system.sshFailureSince);
    const plannedAt = system.startedAt + (system.loopCount + 1) * idleSec * 1000;
    const waitMs = isRecoveryMode
      ? SSH_RECOVERY_RETRY_MS
      : Math.max(0, plannedAt - Date.now());

    system.timer = setTimeout(async () => {
      try {
        if (isRecoveryMode) {
          await probeSshRecovery(system);
          broadcast({ type: "systemUpdate", system: toSummaryView(system) });
          scheduleNextRun();
          return;
        }

        system.loopCount += 1;
        broadcast({ type: "systemUpdate", system: toSummaryView(system) });

        system.collectionInFlight = true;
        await collectOnce(system, system.loopCount);
        system.collectionInFlight = false;
        broadcast({ type: "systemUpdate", system: toSummaryView(system) });

        if (system.loopCount >= system.targetRuns) {
          stopMonitoring(system, "completed", null);
          return;
        }

        scheduleNextRun();
      } catch (err) {
        if (!system.sshFailureSince) {
          system.sshFailureSince = Date.now();
          console.warn(`[SSH FAILURE] System: ${system.systemName} (${system.ip}) - Loop ${system.loopCount}/${system.targetRuns} - Error: ${err.message}`);
        }
        system.error = "SSH connection failed";
        system.lastSshError = String(err?.message || err || "SSH error").replace(/\s+/g, " ").trim();
        const update = toSummaryView(system);
        console.log(`[BROADCAST] systemUpdate: ${system.systemName} - sshFailed: ${update.sshFailed}, waitSec: ${update.sshWaitSec}`);
        broadcast({ type: "systemUpdate", system: update });
        system.collectionInFlight = false;
        await appendLog(system.logPath, "ERROR", err.stack || String(err));

        scheduleNextRun();
      }
    }, waitMs);
  };

  // Collect first loop immediately without waiting
  (async () => {
    try {
      system.loopCount = 1;
      console.log(`[FIRST LOOP IMMEDIATE] System: ${system.systemName} - Collecting loop 1/${system.targetRuns} immediately`);
      broadcast({ type: "systemUpdate", system: toSummaryView(system) });

      system.collectionInFlight = true;
      await collectOnce(system, system.loopCount);
      system.collectionInFlight = false;
      broadcast({ type: "systemUpdate", system: toSummaryView(system) });

      if (system.loopCount >= system.targetRuns) {
        stopMonitoring(system, "completed", null);
        return;
      }

      scheduleNextRun();
    } catch (err) {
      if (!system.sshFailureSince) {
        system.sshFailureSince = Date.now();
        console.warn(`[SSH FAILURE] System: ${system.systemName} (${system.ip}) - Loop ${system.loopCount}/${system.targetRuns} - Error: ${err.message}`);
      }
      system.error = "SSH connection failed";
      system.lastSshError = String(err?.message || err || "SSH error").replace(/\s+/g, " ").trim();
      const update = toSummaryView(system);
      console.log(`[BROADCAST] systemUpdate: ${system.systemName} - sshFailed: ${update.sshFailed}, waitSec: ${update.sshWaitSec}`);
      broadcast({ type: "systemUpdate", system: update });
      system.collectionInFlight = false;
      await appendLog(system.logPath, "ERROR", err.stack || String(err));

      scheduleNextRun();
    }
  })();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ssh-monitor-ui", time: new Date().toISOString() });
});

app.get("/api/systems", (_req, res) => {
  const all = Array.from(systems.values()).map(toSummaryView);
  res.json(all);
});

app.get("/api/systems/active", (_req, res) => {
  const active = Array.from(systems.values())
    .filter((s) => s.status === "running")
    .map(toSummaryView);
  res.json(active);
});

app.post("/api/systems/clear-history", (_req, res) => {
  let removed = 0;
  for (const [id, system] of systems.entries()) {
    if (system.status !== "running") {
      if (system.timer) {
        clearTimeout(system.timer);
      }
      systems.delete(id);
      removed += 1;
    }
  }

  broadcast({
    type: "historyCleared",
    removed,
    systems: Array.from(systems.values()).map(toSummaryView)
  });

  res.json({ removed });
});

app.post("/api/systems", async (req, res) => {
  const {
    systemName,
    ip,
    username,
    password,
    sshPort,
    idleTimeSec,
    monitorDurationSec,
    pmutilCommand,
    turbostatCommand
  } = req.body || {};

  if (!systemName || !ip) {
    res.status(400).json({ error: "systemName and ip are required" });
    return;
  }

  const resolvedCreds = resolveSshCredentials({ username, password });
  if (!resolvedCreds.username || !resolvedCreds.password) {
    res.status(400).json({
      error:
        "SSH credentials missing. Provide SSH Username/Password in the system card or set SSH_USERNAME and SSH_PASSWORD environment variables."
    });
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeName = sanitizeFileSegment(systemName);
  const safeIp = sanitizeFileSegment(ip);
  const logPath = path.join(logsDir, `${safeName}_${safeIp}_${id}.txt`);

  const system = {
    id,
    systemName,
    ip,
    sshPort: Number(sshPort) || 22,
    username: resolvedCreds.username,
    password: resolvedCreds.password,
    idleTimeSec: Number(idleTimeSec) || 10,
    monitorDurationSec: Number(monitorDurationSec) || 60,
    pmutilCommand: pmutilCommand || DEFAULT_COMMANDS.pmutil,
    turbostatCommand: turbostatCommand || DEFAULT_COMMANDS.turbostat,
    status: "idle",
    timer: null,
    startedAt: null,
    endedAt: null,
    error: null,
    lastPmutil: "",
    lastTurbostat: "",
    lastParsed: {
      sockets: null,
      c6: null,
      pc6: null
    },
    sshFailureSince: null,
    lastReconnectSec: null,
    lastConnectMs: null,
    sshRecoveredAt: null,
    sshRecoveryDisplayUntil: null,
    totalPausedMs: 0,
    sshReattemptCount: 0,
    lastSshError: null,
    sshCheckInFlight: false,
    lastHeartbeatAt: null,
    collectionInFlight: false,
    loopCount: 0,
    targetRuns: 0,
    logPath
  };

  systems.set(id, system);
  await appendLog(logPath, "SYSTEM_REGISTERED", JSON.stringify({ systemName, ip }, null, 2));
  broadcast({ type: "systemAdded", system: toSummaryView(system) });
  res.status(201).json(toSummaryView(system));
});

app.post("/api/systems/:id/start", async (req, res) => {
  const system = systems.get(req.params.id);
  if (!system) {
    res.status(404).json({ error: "System not found" });
    return;
  }

  try {
    await startMonitoring(system);
    res.json(toSummaryView(system));
  } catch (err) {
    stopMonitoring(system, "error", err.message || "Unable to start");
    res.status(500).json({ error: system.error });
  }
});

app.post("/api/systems/:id/stop", async (req, res) => {
  const system = systems.get(req.params.id);
  if (!system) {
    res.status(404).json({ error: "System not found" });
    return;
  }
  stopMonitoring(system, "stopped", null);
  await appendLog(system.logPath, "STOPPED", "Monitoring stopped by user");
  res.json(toSummaryView(system));
});

app.get("/api/systems/:id/details", (req, res) => {
  const system = systems.get(req.params.id);
  if (!system) {
    res.status(404).json({ error: "System not found" });
    return;
  }

  res.json({
    ...toSummaryView(system),
    pmutilOutput: system.lastPmutil,
    turbostatOutput: system.lastTurbostat
  });
});

app.get("/api/systems/:id/log", async (req, res) => {
  const system = systems.get(req.params.id);
  if (!system) {
    res.status(404).json({ error: "System not found" });
    return;
  }

  try {
    const content = await fsp.readFile(system.logPath, "utf8");
    res.type("text/plain").send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, async () => {
  await ensureLogsDir();
  if (!DEFAULT_SSH_USERNAME || !DEFAULT_SSH_PASSWORD) {
    console.warn(
      "[STARTUP WARNING] SSH_USERNAME/SSH_PASSWORD env vars are not set. You must enter SSH Username/Password per system card before starting monitoring."
    );
  }
  console.log(`Server listening on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.send(
    JSON.stringify({
      type: "welcome",
      message: "WebSocket connected",
      systems: Array.from(systems.values()).map(toSummaryView)
    })
  );

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

setInterval(() => {
  for (const system of systems.values()) {
    if (system.status === "running") {
      heartbeatSsh(system);
      const view = toSummaryView(system);
      if (system.sshFailureSince) {
        console.log(`[TICK] ${system.systemName} - sshFailed: true, waitSec: ${view.sshWaitSec}`);
      }
      broadcast({ type: "tick", system: view });
    }
  }
}, 1000);

process.on("SIGINT", () => {
  for (const system of systems.values()) {
    if (system.timer) {
      clearTimeout(system.timer);
    }
  }
  process.exit(0);
});
