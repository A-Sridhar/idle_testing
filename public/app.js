const systemCountInput = document.getElementById("systemCount");
const systemsContainer = document.getElementById("systemsContainer");
const summaryBody = document.getElementById("summaryBody");
const previousSummaryBody = document.getElementById("previousSummaryBody");
const refreshSummaryBtn = document.getElementById("refreshSummary");
const clearHistoryBtn = document.getElementById("clearHistory");
const cardTemplate = document.getElementById("systemCardTemplate");

const localCards = [];
const systemsById = new Map();
let ws;

function fmtLoop(system) {
	const done = Number(system.loopCount) || 0;
	const total = Number(system.targetRuns) || 0;
	return `${done}/${total}`;
}

function fmtSec(sec) {
	const total = Math.max(0, Number(sec) || 0);
	const m = Math.floor(total / 60)
		.toString()
		.padStart(2, "0");
	const s = Math.floor(total % 60)
		.toString()
		.padStart(2, "0");
	return `${m}:${s}`;
}

function fmtDateTime(value) {
	if (!value) return "-";
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return "-";
	return d.toLocaleString();
}

function metricClass(value) {
	const num = Number(value);
	if (Number.isNaN(num)) return "";
	if (num === 0) return "metric-red";
	if (num < 90) return "metric-orange";
	return "metric-green";
}

function metricHtml(value) {
	if (value === null || value === undefined || value === "") {
		return "-";
	}
	const cls = metricClass(value);
	if (!cls) {
		return `${value}`;
	}
	return `<span class="${cls}">${value}</span>`;
}

function systemLinkHtml(system) {
	if (!system || !system.id) {
		return `${system?.systemName || "-"}`;
	}
	const text = system.systemName || "-";
	return `<a class="detail-link" href="system.html?id=${encodeURIComponent(system.id)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function activeSystemCellHtml(system) {
	const link = systemLinkHtml(system);
	const isSshWarning = Boolean(system.sshFailed);
	const isSshRecovered = Boolean(system.sshRecoveredAt) && system.lastReconnectSec !== undefined;
	if (isSshWarning) {
		const reason = system.sshWarningText ? ` | ${system.sshWarningText}` : "";
		console.warn(`[SSH WARNING RENDERED] ${system.systemName} - sshFailed: ${system.sshFailed}, waitSec: ${system.sshWaitSec}`);
		return `<div>${link}</div><div class="summary-warn">SSH failed. Wait time: ${system.sshWaitSec || 0}s${reason}</div>`;
	}
	if (isSshRecovered) {
		console.log(`[SSH RECOVERY RENDERED] ${system.systemName} - Connected after: ${system.lastReconnectSec}s`);
		return `<div>${link}</div><div class="summary-success">SSH connected after ${system.lastReconnectSec}s</div>`;
	}
	return link;
}

function statusClass(status) {
	if (status === "running") return "status-running";
	if (status === "error") return "status-error";
	if (status === "completed") return "status-completed";
	if (status === "stopped") return "status-stopped";
	return "status-idle";
}

function createCard(index) {
	const fragment = document.importNode(cardTemplate.content, true);
	const card = fragment.querySelector(".system-card") || fragment.firstElementChild;
	const title = card.querySelector(".system-title");
	const statusPill = card.querySelector(".status-pill");
	const startBtn = card.querySelector(".btn-start");
	const logLine = card.querySelector(".log-line");

	const local = {
		index,
		card,
		id: null,
		statusPill,
		logLine,
		fieldName: card.querySelector(".field-name"),
		fieldIp: card.querySelector(".field-ip"),
		fieldUsername: card.querySelector(".field-username"),
		fieldPassword: card.querySelector(".field-password"),
		fieldIdle: card.querySelector(".field-idle"),
		fieldMonitor: card.querySelector(".field-monitor")
	};

	title.textContent = `System ${index + 1}`;

	startBtn.addEventListener("click", async () => {
		if (local.id) {
			const current = systemsById.get(local.id);
			if (current && current.status === "running") {
				return;
			}
		}

		await saveSystem(local, { forceNew: true });
		if (local.id) {
			await fetch(`/api/systems/${local.id}/start`, { method: "POST" });
		}
	});

	systemsContainer.appendChild(fragment);
	localCards.push(local);
}

function buildCards() {
	const desiredCount = Math.max(1, Number(systemCountInput.value) || 1);

	if (desiredCount > localCards.length) {
		for (let i = localCards.length; i < desiredCount; i += 1) {
			createCard(i);
		}
		return;
	}

	if (desiredCount < localCards.length) {
		while (localCards.length > desiredCount) {
			const last = localCards[localCards.length - 1];
			if (last.statusPill.textContent.trim() === "running") {
				break;
			}
			last.card.remove();
			localCards.pop();
		}

		// Keep count aligned with cards that must stay (e.g., running systems).
		systemCountInput.value = String(localCards.length);
	}
}

async function saveSystem(local, options = {}) {
	const forceNew = Boolean(options.forceNew);

	if (local.id && !forceNew) {
		return;
	}

	if (forceNew) {
		local.id = null;
	}

	const payload = {
		systemName: local.fieldName.value.trim() || `System-${local.index + 1}`,
		ip: local.fieldIp.value.trim(),
		username: local.fieldUsername.value.trim(),
		password: local.fieldPassword.value,
		idleTimeSec: Number(local.fieldIdle.value) || 10,
		monitorDurationSec: Number(local.fieldMonitor.value) || 60
	};

	if (!payload.ip) {
		local.logLine.textContent = "IP is required.";
		return;
	}

	const res = await fetch("/api/systems", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});
	const data = await res.json();
	if (!res.ok) {
		local.logLine.textContent = data.error || "Unable to save system.";
		return;
	}

	local.id = data.id;
	local.fieldIdle.value = data.idleTimeSec;
	local.fieldMonitor.value = data.monitorDurationSec;
	systemsById.set(data.id, data);
	renderSummary();
}

function applySystemUpdate(data) {
	systemsById.set(data.id, data);

	const local = localCards.find((c) => c.id === data.id);
	if (local) {
		local.statusPill.textContent = data.status;
		local.statusPill.className = `status-pill ${statusClass(data.status)}`;
		local.fieldIdle.value = data.idleTimeSec;
		local.fieldMonitor.value = data.monitorDurationSec;
		local.logLine.classList.remove("warn");
		local.logLine.textContent = "";
	}

	renderSummary();
}

function renderSummary() {
	const active = Array.from(systemsById.values()).filter((s) => s.status === "running" || s.sshFailed || s.status === "error");
	summaryBody.innerHTML = "";

	if (!active.length) {
		const tr = document.createElement("tr");
		tr.innerHTML = `<td colspan="13" class="empty">No running systems</td>`;
		summaryBody.appendChild(tr);
	} else {
		for (const system of active) {
			const tr = document.createElement("tr");
			tr.innerHTML = `
				<td>${activeSystemCellHtml(system)}</td>
				<td>${system.ip || "-"}</td>
				<td>${fmtDateTime(system.startDateTime)}</td>
				<td>${system.idleTimeSec || "-"}</td>
				<td>${system.monitorDurationSec || "-"}</td>
				<td>${system.sshReattemptCount ?? 0}</td>
				<td>${system.sockets ?? "-"}</td>
				<td>${metricHtml(system.c6)}</td>
				<td>${metricHtml(system.pc6)}</td>
				<td>${fmtLoop(system)}</td>
				<td>${fmtSec(system.elapsedSec)}</td>
				<td>${fmtSec(system.leftSec)}</td>
				<td><button class="btn btn-danger btn-stop-summary" data-system-id="${system.id}" type="button">Stop</button></td>
			`;
			summaryBody.appendChild(tr);
		}
	}

	renderPreviousSummary();
}

function renderPreviousSummary() {
	const historical = Array.from(systemsById.values()).filter(
		(s) => s.status === "stopped" || s.status === "completed" || s.status === "error"
	);
	previousSummaryBody.innerHTML = "";

	if (!historical.length) {
		const tr = document.createElement("tr");
		tr.innerHTML = `<td colspan="13" class="empty">No previous systems</td>`;
		previousSummaryBody.appendChild(tr);
		return;
	}

	for (const system of historical) {
		const tr = document.createElement("tr");
		tr.innerHTML = `
			<td>${systemLinkHtml(system)}</td>
			<td>${system.ip || "-"}</td>
			<td>${fmtDateTime(system.startDateTime)}</td>
			<td>${fmtDateTime(system.endDateTime)}</td>
			<td>${system.idleTimeSec || "-"}</td>
			<td>${system.monitorDurationSec || "-"}</td>
			<td>${system.sshReattemptCount ?? 0}</td>
			<td>${system.sockets ?? "-"}</td>
			<td>${metricHtml(system.c6)}</td>
			<td>${metricHtml(system.pc6)}</td>
			<td>${fmtLoop(system)}</td>
			<td>${fmtSec(system.elapsedSec)}</td>
			<td>${system.status}</td>
		`;
		previousSummaryBody.appendChild(tr);
	}
}

async function refreshSystems() {
	const res = await fetch("/api/systems");
	const list = await res.json();
	systemsById.clear();
	for (const item of list) {
		systemsById.set(item.id, item);
	}
	renderSummary();
	renderPreviousSummary();
}

function connectWs() {
	const protocol = location.protocol === "https:" ? "wss" : "ws";
	ws = new WebSocket(`${protocol}://${location.host}`);

	ws.onmessage = (event) => {
		try {
			const message = JSON.parse(event.data);
			if (message.type === "welcome" && Array.isArray(message.systems)) {
				for (const system of message.systems) {
					systemsById.set(system.id, system);
				}
				renderSummary();
			}
			if (message.type === "historyCleared" && Array.isArray(message.systems)) {
				systemsById.clear();
				for (const system of message.systems) {
					systemsById.set(system.id, system);
				}
				renderSummary();
			}
			if (message.type === "systemAdded" || message.type === "systemUpdate" || message.type === "tick") {
				if (message.system && message.system.sshFailed) {
					console.log(`[WS RECEIVED] ${message.type} - ${message.system.systemName} - sshFailed: true, waitSec: ${message.system.sshWaitSec}`);
				}
				applySystemUpdate(message.system);
			}
		} catch (_err) {
			// ignore malformed websocket event
		}
	};

	ws.onclose = () => {
		setTimeout(connectWs, 1500);
	};
}

systemCountInput.addEventListener("input", buildCards);
refreshSummaryBtn.addEventListener("click", refreshSystems);
clearHistoryBtn?.addEventListener("click", async () => {
	await fetch("/api/systems/clear-history", { method: "POST" });
	await refreshSystems();
});
summaryBody.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}
	if (!target.classList.contains("btn-stop-summary")) {
		return;
	}
	const id = target.getAttribute("data-system-id");
	if (!id) {
		return;
	}
	await fetch(`/api/systems/${id}/stop`, { method: "POST" });
});

buildCards();
refreshSystems();
connectWs();
