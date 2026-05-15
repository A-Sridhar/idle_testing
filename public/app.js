const formSystemName = document.getElementById("formSystemName");
const formSystemIp = document.getElementById("formSystemIp");
const formSshOsType = document.getElementById("formSshOsType");
const formSystemUsername = document.getElementById("formSystemUsername");
const formSystemPassword = document.getElementById("formSystemPassword");
const formIdleTime = document.getElementById("formIdleTime");
const formIdleUnit = document.getElementById("formIdleUnit");
const formMonitorDuration = document.getElementById("formMonitorDuration");
const formMonitorUnit = document.getElementById("formMonitorUnit");
const addSystemBtn = document.getElementById("addSystemBtn");
const clearFormBtn = document.getElementById("clearFormBtn");
const formError = document.getElementById("formError");
const summaryBody = document.getElementById("summaryBody");
const previousSummaryBody = document.getElementById("previousSummaryBody");
const refreshSummaryBtn = document.getElementById("refreshSummary");
const clearHistoryBtn = document.getElementById("clearHistory");
const roleSelect = document.getElementById("roleSelect");

const systemsById = new Map();
let ws;
let currentRole = "user";

// Initialize role from localStorage
function initRole() {
	const stored = localStorage.getItem("idleTestingRole");
	const isAdminAuth = localStorage.getItem("idleTestingAdminAuth") === "true";
	if (stored && ["user", "admin"].includes(stored)) {
		if (stored === "admin" && !isAdminAuth) {
			// Admin role was stored but not authenticated, revert to user
			currentRole = "user";
			localStorage.removeItem("idleTestingRole");
		} else {
			currentRole = stored;
		}
	}
	if (roleSelect) {
		roleSelect.value = currentRole;
	}
	updateRoleVisibility();
}

// Update UI visibility based on role
function updateRoleVisibility() {
	const isAdmin = currentRole === "admin";
	if (clearHistoryBtn) {
		if (isAdmin) {
			clearHistoryBtn.classList.remove("btn-admin-only");
			clearHistoryBtn.disabled = false;
		} else {
			clearHistoryBtn.classList.add("btn-admin-only");
			clearHistoryBtn.disabled = true;
		}
	}
	updateStopButtons();
}

// Update stop button visibility
function updateStopButtons() {
	const isAdmin = currentRole === "admin";
	const stopButtons = document.querySelectorAll(".btn-stop-summary");
	stopButtons.forEach((btn) => {
		if (isAdmin) {
			btn.classList.remove("btn-admin-only");
			btn.disabled = false;
		} else {
			btn.classList.add("btn-admin-only");
			btn.disabled = true;
		}
	});
}

// Handle role change
if (roleSelect) {
	roleSelect.addEventListener("change", async (e) => {
		const newRole = e.target.value;
		if (newRole === "admin") {
			// Show login modal
			showAdminLoginModal();
		} else {
			currentRole = "user";
			localStorage.setItem("idleTestingRole", "user");
			localStorage.removeItem("idleTestingAdminAuth");
			updateRoleVisibility();
		}
	});
}

const adminLoginModal = document.getElementById("adminLoginModal");
const adminUsername = document.getElementById("adminUsername");
const adminPassword = document.getElementById("adminPassword");
const adminLoginBtn = document.getElementById("adminLoginBtn");
const adminLoginCancel = document.getElementById("adminLoginCancel");
const adminLoginError = document.getElementById("adminLoginError");

function showAdminLoginModal() {
	adminLoginError.style.display = "none";
	adminUsername.value = "";
	adminPassword.value = "";
	adminLoginModal.style.display = "flex";
	adminUsername.focus();
}

function hideAdminLoginModal() {
	adminLoginModal.style.display = "none";
}

function authenticateAdmin() {
	const username = adminUsername.value.trim();
	const password = adminPassword.value;
	if (username === "admin" && password === "intel@123") {
		currentRole = "admin";
		localStorage.setItem("idleTestingRole", "admin");
		localStorage.setItem("idleTestingAdminAuth", "true");
		if (roleSelect) roleSelect.value = "admin";
		updateRoleVisibility();
		hideAdminLoginModal();
	} else {
		adminLoginError.textContent = "Invalid credentials";
		adminLoginError.style.display = "block";
		adminPassword.value = "";
	}
}

adminLoginBtn.addEventListener("click", authenticateAdmin);
adminPassword.addEventListener("keypress", (e) => {
	if (e.key === "Enter") authenticateAdmin();
});
adminLoginCancel.addEventListener("click", () => {
	hideAdminLoginModal();
	if (roleSelect) roleSelect.value = currentRole;
});
adminLoginModal.addEventListener("click", (e) => {
	if (e.target === adminLoginModal) {
		hideAdminLoginModal();
		if (roleSelect) roleSelect.value = currentRole;
	}
});

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
	const isSshWarning = system.status === "running" && Boolean(system.sshFailed);
	const isSshRecovered = Boolean(system.sshRecoveredAt) && system.lastReconnectSec !== undefined;
	if (isSshWarning) {
		const reason = system.sshWarningText ? ` | ${system.sshWarningText}` : "";
		return `<div>${link}</div><div class="summary-warn">SSH failed. Wait time: ${system.sshWaitSec || 0}s${reason}</div>`;
	}
	if (isSshRecovered) {
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

function showFormError(message) {
	formError.textContent = message;
	formError.style.display = "block";
	setTimeout(() => {
		formError.style.display = "none";
	}, 4000);
}

function clearForm() {
	formSystemName.value = "";
	formSystemIp.value = "";
	formSshOsType.value = "centos";
	formSystemUsername.value = "";
	formSystemPassword.value = "";
	formIdleTime.value = "10";
	formIdleUnit.value = "s";
	formMonitorDuration.value = "60";
	formMonitorUnit.value = "s";
	formError.style.display = "none";
	updateSshCredentials();
}

function updateSshCredentials() {
	const osType = formSshOsType.value;
	const usernameWrapper = document.getElementById("formSystemUsernameWrapper");
	const passwordWrapper = document.getElementById("formSystemPasswordWrapper");
	
	if (osType === "centos") {
		formSystemUsername.value = "root";
		formSystemPassword.value = "intel@123";
		usernameWrapper.style.display = "none";
		passwordWrapper.style.display = "none";
	} else if (osType === "windows") {
		formSystemUsername.value = "Administrator";
		formSystemPassword.value = "intel@123";
		usernameWrapper.style.display = "none";
		passwordWrapper.style.display = "none";
	} else {
		formSystemUsername.value = "";
		formSystemPassword.value = "";
		usernameWrapper.style.display = "block";
		passwordWrapper.style.display = "block";
	}
}

async function addSystem() {
	const ip = formSystemIp.value.trim();
	if (!ip) {
		showFormError("IP Address is required.");
		return;
	}

	const idleSeconds = Number(formIdleTime.value) || 10;
	const idleTimeSec = formIdleUnit.value === "m" ? idleSeconds * 60 : idleSeconds;
	const monitorSeconds = Number(formMonitorDuration.value) || 60;
	const monitorDurationSec = formMonitorUnit.value === "m" ? monitorSeconds * 60 : monitorSeconds;

	const payload = {
		systemName: formSystemName.value.trim() || `System-${Date.now()}`,
		ip,
		username: formSystemUsername.value.trim(),
		password: formSystemPassword.value,
		idleTimeSec,
		monitorDurationSec
	};

	try {
		const res = await fetch("/api/systems", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		const data = await res.json();
		if (!res.ok) {
			showFormError(data.error || "Failed to add system.");
			return;
		}

		systemsById.set(data.id, data);
		clearForm();

		// Start monitoring immediately
		await fetch(`/api/systems/${data.id}/start`, { method: "POST" });
		await refreshSystems();
	} catch (e) {
		showFormError("Error adding system: " + e.message);
	}
}

addSystemBtn.addEventListener("click", addSystem);
clearFormBtn.addEventListener("click", clearForm);
formSshOsType.addEventListener("change", updateSshCredentials);
formMonitorDuration.addEventListener("keypress", (e) => {
	if (e.key === "Enter") addSystem();
});

function statusClass(status) {
	if (status === "running") return "status-running";
	if (status === "error") return "status-error";
	if (status === "completed") return "status-completed";
	if (status === "stopped") return "status-stopped";
	return "status-idle";
}

function applySystemUpdate(data) {
	systemsById.set(data.id, data);
	renderSummary();
}

function renderSummary() {
	const active = Array.from(systemsById.values()).filter((s) => s.status === "running" || s.status === "error");
	summaryBody.innerHTML = "";

	if (!active.length) {
		const tr = document.createElement("tr");
		tr.innerHTML = `<td colspan="14" class="empty">No running systems</td>`;
		summaryBody.appendChild(tr);
	} else {
		for (let index = 0; index < active.length; index++) {
			const system = active[index];
			const tr = document.createElement("tr");
			tr.innerHTML = `
				<td>${index + 1}</td>
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
	updateStopButtons();
}

function renderPreviousSummary() {
	const historical = Array.from(systemsById.values()).filter(
		(s) => s.status === "stopped" || s.status === "completed" || s.status === "error"
	);
	previousSummaryBody.innerHTML = "";

	if (!historical.length) {
		const tr = document.createElement("tr");
		tr.innerHTML = `<td colspan="15" class="empty">No previous systems</td>`;
		previousSummaryBody.appendChild(tr);
		return;
	}

	for (let index = 0; index < historical.length; index++) {
		const system = historical[index];
		const tr = document.createElement("tr");
		tr.innerHTML = `
			<td>${index + 1}</td>
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
			<td>${system.stopReason || "-"}</td>
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

refreshSummaryBtn.addEventListener("click", refreshSystems);
clearHistoryBtn?.addEventListener("click", async () => {
	if (currentRole !== "admin") {
		alert("Only admins can clear history.");
		return;
	}
	await fetch("/api/systems/clear-history", { method: "POST" });
	await refreshSystems();
});
const logModal = document.getElementById("logModal");
const logModalTitle = document.getElementById("logModalTitle");
const logModalContent = document.getElementById("logModalContent");
const loopSummaryBody = document.getElementById("loopSummaryBody");
const logModalDownload = document.getElementById("logModalDownload");
const logModalClose = document.getElementById("logModalClose");
let _logModalSystemId = null;

function parseTurboStatBlockForC6Pc6(turbostatOutput) {
	const text = turbostatOutput || "";
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	let c6 = null;
	let pc6 = null;

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
			if (!Number.isNaN(cpuVal)) {
				c6 = cpuVal;
			}
			if (!Number.isNaN(pkgVal)) {
				pc6 = pkgVal;
			}
		}

		if (c6 !== null || pc6 !== null) {
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

	return { c6, pc6 };
}

function parseLoopSummaryFromLog(logText) {
	const text = String(logText || "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const byLoop = new Map();

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		const headerMatch = line.match(/^\[[^\]]+\]\s+LOOP_(\d+)_TURBOSTAT\s*$/i);
		if (!headerMatch) {
			continue;
		}

		const loopNumber = Number(headerMatch[1]);
		const blockLines = [];
		for (let j = i + 1; j < lines.length; j += 1) {
			const candidate = lines[j].trim();
			if (/^\[[^\]]+\]\s+\S+/.test(candidate)) {
				break;
			}
			blockLines.push(lines[j]);
			i = j;
		}

		const parsed = parseTurboStatBlockForC6Pc6(blockLines.join("\n"));
		// Keep the latest sample for each loop number.
		byLoop.set(loopNumber, {
			loop: loopNumber,
			c6: parsed.c6,
			pc6: parsed.pc6
		});
	}

	return Array.from(byLoop.values()).sort((a, b) => a.loop - b.loop);
}

function renderLoopSummary(logText) {
	const rows = parseLoopSummaryFromLog(logText);
	if (!rows.length) {
		loopSummaryBody.innerHTML = '<tr><td colspan="3" class="empty">No loop summary found in log</td></tr>';
		return;
	}

	loopSummaryBody.innerHTML = rows
		.map((row) => {
			const c6Text = row.c6 === null ? "-" : String(row.c6);
			const pc6Text = row.pc6 === null ? "-" : String(row.pc6);
			return `<tr><td>${row.loop}</td><td>${c6Text}</td><td>${pc6Text}</td></tr>`;
		})
		.join("");
}

async function openLogPopup(systemId) {
	_logModalSystemId = systemId;
	const system = systemsById.get(systemId);
	logModalTitle.textContent = `Log: ${system ? system.systemName + ' (' + system.ip + ')' : systemId}`;
	logModalContent.textContent = "Loading...";
	loopSummaryBody.innerHTML = '<tr><td colspan="3" class="empty">Loading...</td></tr>';
	logModal.style.display = "flex";
	try {
		const res = await fetch(`/api/systems/${systemId}/log`);
		if (!res.ok) {
			logModalContent.textContent = "Failed to load log.";
			loopSummaryBody.innerHTML = '<tr><td colspan="3" class="empty">Failed to load summary</td></tr>';
			return;
		}

		const logText = (await res.text()) || "(empty log)";
		logModalContent.textContent = logText;
		renderLoopSummary(logText);
	} catch (_e) {
		logModalContent.textContent = "Error loading log.";
		loopSummaryBody.innerHTML = '<tr><td colspan="3" class="empty">Error loading summary</td></tr>';
	}
}

function downloadLog() {
	const system = systemsById.get(_logModalSystemId);
	const name = system ? `${system.systemName}_${system.ip}`.replace(/[^a-zA-Z0-9._-]/g, "_") : _logModalSystemId;
	const blob = new Blob([logModalContent.textContent], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${name}_log.txt`;
	a.click();
	URL.revokeObjectURL(url);
}

logModalClose.addEventListener("click", () => { logModal.style.display = "none"; });
logModalDownload.addEventListener("click", downloadLog);
logModal.addEventListener("click", (e) => { if (e.target === logModal) logModal.style.display = "none"; });

document.addEventListener("keydown", (e) => { if (e.key === "Escape") logModal.style.display = "none"; });

summaryBody.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}
	if (target.classList.contains("btn-log-popup")) {
		const id = target.getAttribute("data-system-id");
		if (id) await openLogPopup(id);
		return;
	}
	if (!target.classList.contains("btn-stop-summary")) {
		return;
	}
	if (currentRole !== "admin") {
		alert("Only admins can stop systems.");
		return;
	}
	const id = target.getAttribute("data-system-id");
	if (!id) {
		return;
	}
	const reasonInput = window.prompt("Please enter the reason for stopping this system:", "");
	if (reasonInput === null) {
		return;
	}
	const reason = reasonInput.trim();
	if (!reason) {
		alert("Stop reason is required.");
		return;
	}
	const confirmed = window.confirm(`Are you sure you want to stop this system?\nReason: ${reason}`);
	if (!confirmed) {
		return;
	}
	await fetch(`/api/systems/${id}/stop`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ reason })
	});
});

previousSummaryBody.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	if (target.classList.contains("btn-log-popup")) {
		const id = target.getAttribute("data-system-id");
		if (id) await openLogPopup(id);
	}
});

initRole();
updateSshCredentials();
refreshSystems();
connectWs();
