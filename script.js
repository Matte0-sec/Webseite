const state = { me: null, conversations: [], groups: [], active: null, events: null };
const $ = (selector) => document.querySelector(selector);
const app = $("#appView");

function refreshIcons() { window.lucide?.createIcons(); }
function escapeHtml(value = "") { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function initials(name = "?") { return name.split(/[._ -]/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function avatar(user, size = "") { return user.profileImage ? `<img class="avatar ${size}" src="${user.profileImage}" alt="">` : `<span class="avatar ${size}">${escapeHtml(initials(user.username || user.name))}</span>`; }
function displayTime(value) { if (!value) return ""; const date = new Date(value); const today = new Date(); return date.toDateString() === today.toDateString() ? date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); }
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("visible"); clearTimeout(window.toastTimeout); window.toastTimeout = setTimeout(() => element.classList.remove("visible"), 3200); }

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showAuthentication();
    throw new Error(payload.error || "Etwas ist schiefgelaufen.");
  }
  return payload;
}

function showAuthentication() { state.events?.close(); state.events = null; state.me = null; app.classList.add("hidden"); $("#authView").classList.remove("hidden"); }
function renderProfile() { $("#ownProfile").innerHTML = `${avatar(state.me, "large")}<div class="profile-copy"><strong>${escapeHtml(state.me.username)}</strong><span>${escapeHtml(state.me.status || "Online")}</span></div>`; }
function activateView(view) { document.querySelectorAll(".content-view").forEach((node) => node.classList.add("hidden")); $(`#${view}View`).classList.remove("hidden"); document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view)); if (view === "chats") loadConversations(); if (view === "groups") loadGroups(); }

async function startApp() {
  state.me = await api("/me");
  $("#authView").classList.add("hidden"); app.classList.remove("hidden"); renderProfile(); await loadConversations(); connectRealtime(); refreshIcons();
}

async function loadConversations() { state.conversations = await api("/chats"); renderConversations(); }
function renderConversations() {
  const container = $("#conversationList");
  if (!state.conversations.length) { container.innerHTML = `<p class="empty-state">Noch keine Nachrichten. Finde eine Person und starte ein Gespraech.</p>`; return; }
  container.innerHTML = state.conversations.map((chat) => `<button class="conversation-item ${state.active?.kind === "chat" && state.active.id === chat.id ? "active" : ""}" data-chat="${chat.id}">${avatar(chat.other)}<div class="item-copy"><div class="item-title-row"><strong>${escapeHtml(chat.other.username)}</strong><time>${displayTime(chat.lastMessage?.createdAt)}</time></div><span class="preview">${escapeHtml(chat.lastMessage ? `${chat.lastMessage.senderName}: ${chat.lastMessage.body}` : "Noch keine Nachrichten")}</span></div>${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ""}</button>`).join("");
  container.querySelectorAll("[data-chat]").forEach((button) => button.addEventListener("click", () => openChat(Number(button.dataset.chat)))); refreshIcons();
}
async function openChat(id) {
  const chat = state.conversations.find((item) => item.id === id);
  if (!chat) return;
  state.active = { kind: "chat", id, title: chat.other.username, subtitle: chat.other.status || "Privater Chat", profileImage: chat.other.profileImage };
  await loadMessages(); app.classList.add("chat-open"); renderConversations();
}

async function loadGroups() { state.groups = await api("/groups"); renderGroups(); }
function renderGroups() {
  const container = $("#groupList");
  if (!state.groups.length) { container.innerHTML = `<p class="empty-state">Noch keine Gruppe vorhanden. Erstelle die erste Gemeinschaft.</p>`; return; }
  container.innerHTML = state.groups.map((group) => `<article class="group-card">${avatar({ username: group.name, profileImage: group.image })}<div class="item-copy"><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.description || "Private Gruppe")}</p></div>${group.isMember ? `<button class="primary-button" data-open-group="${group.id}">Oeffnen</button>` : group.requestStatus === "requested" ? `<span class="preview">Anfrage offen</span>` : `<button class="primary-button" data-join-group="${group.id}">Anfragen</button>`}</article>`).join("");
  container.querySelectorAll("[data-open-group]").forEach((button) => button.addEventListener("click", () => openGroup(Number(button.dataset.openGroup))));
  container.querySelectorAll("[data-join-group]").forEach((button) => button.addEventListener("click", () => joinGroup(Number(button.dataset.joinGroup))));
}
async function joinGroup(id) { try { await api(`/groups/${id}/join`, { method: "POST" }); toast("Beitrittsanfrage wurde gesendet."); await loadGroups(); } catch (error) { toast(error.message); } }
async function openGroup(id) {
  const group = state.groups.find((item) => item.id === id);
  if (!group?.isMember) return;
  state.active = { kind: "group", id, title: group.name, subtitle: "Private Gruppe", profileImage: group.image, role: group.role, description: group.description };
  await loadMessages(); app.classList.add("chat-open");
}

async function loadMessages() {
  if (!state.active) return;
  const path = state.active.kind === "chat" ? `/chats/${state.active.id}/messages` : `/groups/${state.active.id}/messages`;
  const response = await api(path); renderChat(response.messages || []);
  if (state.active.kind === "chat") loadConversations();
}
function renderChat(messages) {
  const active = state.active;
  $("#chatEmpty").classList.add("hidden"); $("#activeChat").classList.remove("hidden");
  const manage = active.kind === "group" && ["owner", "admin"].includes(active.role) ? `<div class="header-tools"><button id="manageGroupButton" class="icon-button" title="Gruppe verwalten" aria-label="Gruppe verwalten"><i data-lucide="settings-2"></i></button></div>` : "";
  $("#chatHeader").innerHTML = `<button id="backButton" class="icon-button back-button" aria-label="Zurueck"><i data-lucide="arrow-left"></i></button>${avatar({ username: active.title, profileImage: active.profileImage }, "large")}<div><strong>${escapeHtml(active.title)}</strong><span>${escapeHtml(active.subtitle)}</span></div>${manage}`;
  const feed = $("#messages");
  feed.innerHTML = messages.map((message) => `<article class="message ${message.senderId === state.me.id ? "own" : ""}">${active.kind === "group" && message.senderId !== state.me.id ? `<span class="sender">${escapeHtml(message.senderName)}</span>` : ""}<p>${escapeHtml(message.body)}</p><time>${displayTime(message.createdAt)}</time></article>`).join("");
  feed.scrollTop = feed.scrollHeight; $("#messageInput").disabled = false;
  $("#backButton")?.addEventListener("click", () => app.classList.remove("chat-open")); $("#manageGroupButton")?.addEventListener("click", openManagement); refreshIcons();
}
async function sendMessage(event) {
  event.preventDefault(); const input = $("#messageInput"); const body = input.value.trim();
  if (!body || !state.active) return;
  try { const path = state.active.kind === "chat" ? `/chats/${state.active.id}/messages` : `/groups/${state.active.id}/messages`; await api(path, { method: "POST", body: JSON.stringify({ body }) }); input.value = ""; await loadMessages(); } catch (error) { toast(error.message); }
}

async function searchPeople() {
  const query = $("#userSearch").value.trim(); const container = $("#searchResults");
  if (query.length < 2) { container.className = "person-list empty-state"; container.textContent = "Gib mindestens zwei Zeichen ein."; return; }
  try {
    const users = await api(`/users?q=${encodeURIComponent(query)}`); container.className = "person-list";
    container.innerHTML = users.length ? users.map((user) => `<article class="person-item">${avatar(user)}<div class="item-copy"><strong>${escapeHtml(user.username)}</strong><span class="preview">${escapeHtml(user.status || "Kein Status")}</span></div><button class="primary-button" data-user="${user.id}">Chat</button></article>`).join("") : `<p class="empty-state">Keine passenden Personen gefunden.</p>`;
    container.querySelectorAll("[data-user]").forEach((button) => button.addEventListener("click", () => createChat(Number(button.dataset.user))));
  } catch (error) { toast(error.message); }
}
async function createChat(userId) {
  try { const chat = await api("/chats", { method: "POST", body: JSON.stringify({ userId }) }); await loadConversations(); activateView("chats"); await openChat(chat.id); } catch (error) { toast(error.message); }
}
function imageAsDataUrl(input) {
  return new Promise((resolve, reject) => { const file = input.files[0]; if (!file) return resolve(""); if (file.size > 650000) return reject(new Error("Das Bild darf hoechstens 650 KB gross sein.")); const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Das Bild konnte nicht gelesen werden.")); reader.readAsDataURL(file); });
}
async function createGroup(event) {
  event.preventDefault();
  try { const image = await imageAsDataUrl($("#groupImage")); await api("/groups", { method: "POST", body: JSON.stringify({ name: $("#groupName").value.trim(), description: $("#groupDescription").value.trim(), image }) }); event.target.reset(); $("#groupDialog").close(); toast("Private Gruppe wurde erstellt."); activateView("groups"); } catch (error) { toast(error.message); }
}
async function saveProfile(event) {
  event.preventDefault();
  try { const profileImage = await imageAsDataUrl($("#profileImage")); state.me = await api("/profile", { method: "POST", body: JSON.stringify({ status: $("#profileStatus").value.trim(), profileImage }) }); renderProfile(); $("#profileDialog").close(); toast("Profil gespeichert."); } catch (error) { toast(error.message); }
}

async function openManagement() {
  const group = state.active; if (!group || group.kind !== "group") return;
  $("#manageTitle").textContent = group.title; $("#editGroupName").value = group.title; $("#editGroupDescription").value = group.description || ""; $("#manageDialog").showModal();
  try {
    const [requests, members] = await Promise.all([api(`/groups/${group.id}/requests`), api(`/groups/${group.id}/members`)]);
    $("#requestList").innerHTML = requests.length ? requests.map((request) => `<div class="manage-row"><span>${escapeHtml(request.user.username)}</span><button data-decision="accepted" data-request="${request.id}">Annehmen</button><button data-decision="declined" data-request="${request.id}">Ablehnen</button></div>`).join("") : `<small>Keine offenen Anfragen.</small>`;
    $("#memberList").innerHTML = members.map((member) => `<div class="manage-row"><span>${escapeHtml(member.username)} <small>${member.role}</small></span>${member.role !== "owner" ? memberControls(member) : ""}</div>`).join("");
    $("#requestList").querySelectorAll("[data-request]").forEach((button) => button.addEventListener("click", () => decideRequest(Number(button.dataset.request), button.dataset.decision)));
    $("#memberList").querySelectorAll("[data-member]").forEach((button) => button.addEventListener("click", () => changeMember(Number(button.dataset.member), button.dataset.memberAction)));
  } catch (error) { toast(error.message); }
}
function memberControls(member) {
  const controls = [`<button data-member="${member.id}" data-member-action="remove">Entfernen</button>`];
  if (state.active.role === "owner") controls.push(`<button data-member="${member.id}" data-member-action="${member.role === "admin" ? "member" : "admin"}">${member.role === "admin" ? "Mitglied" : "Admin"}</button>`);
  return controls.join("");
}
async function decideRequest(requestId, decision) { try { await api(`/groups/${state.active.id}/requests/${requestId}`, { method: "POST", body: JSON.stringify({ decision }) }); await loadGroups(); await openManagement(); } catch (error) { toast(error.message); } }
async function changeMember(userId, action) { try { await api(`/groups/${state.active.id}/members`, { method: "POST", body: JSON.stringify({ userId, action }) }); await loadGroups(); await openManagement(); } catch (error) { toast(error.message); } }
async function saveGroupEdit(event) { event.preventDefault(); try { await api(`/groups/${state.active.id}`, { method: "POST", body: JSON.stringify({ name: $("#editGroupName").value.trim(), description: $("#editGroupDescription").value.trim() }) }); state.active.title = $("#editGroupName").value.trim(); state.active.description = $("#editGroupDescription").value.trim(); await loadGroups(); await loadMessages(); toast("Gruppe aktualisiert."); } catch (error) { toast(error.message); } }
async function removeGroup() { if (!state.active || !confirm("Diese Gruppe wirklich loeschen?")) return; try { await api(`/groups/${state.active.id}`, { method: "DELETE" }); $("#manageDialog").close(); state.active = null; $("#activeChat").classList.add("hidden"); $("#chatEmpty").classList.remove("hidden"); app.classList.remove("chat-open"); await loadGroups(); toast("Gruppe wurde geloescht."); } catch (error) { toast(error.message); } }

function connectRealtime() { state.events?.close(); state.events = new EventSource("/api/events"); state.events.addEventListener("refresh", () => { loadConversations(); loadGroups(); if (state.active) loadMessages().catch(() => {}); }); }
function openProfile() { $("#profileUsername").value = state.me.username; $("#profileStatus").value = state.me.status || ""; $("#profileImage").value = ""; $("#profileDialog").showModal(); }
function applyTheme() { document.body.classList.toggle("dark", localStorage.getItem("connectchat-theme") === "dark"); }

$("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/auth/login", { method: "POST", body: JSON.stringify({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }) }); await startApp(); } catch (error) { toast(error.message); } });
$("#registerForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/auth/register", { method: "POST", body: JSON.stringify({ username: $("#registerUsername").value.trim(), password: $("#registerPassword").value, status: $("#registerStatus").value.trim() }) }); await startApp(); } catch (error) { toast(error.message); } });
document.querySelectorAll("[data-auth-form]").forEach((button) => button.addEventListener("click", () => { $("#loginForm").classList.toggle("hidden", button.dataset.authForm !== "loginForm"); $("#registerForm").classList.toggle("hidden", button.dataset.authForm !== "registerForm"); }));
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
$("#newChatButton").addEventListener("click", () => activateView("people")); $("#createGroupButton").addEventListener("click", () => $("#groupDialog").showModal()); $("#groupForm").addEventListener("submit", createGroup); $("#profileButton").addEventListener("click", openProfile); $("#profileForm").addEventListener("submit", saveProfile); $("#messageForm").addEventListener("submit", sendMessage); $("#editGroupForm").addEventListener("submit", saveGroupEdit); $("#deleteGroupButton").addEventListener("click", removeGroup);
$("#userSearch").addEventListener("input", () => { clearTimeout(window.searchDelay); window.searchDelay = setTimeout(searchPeople, 250); }); $("#themeButton").addEventListener("click", () => { localStorage.setItem("connectchat-theme", document.body.classList.contains("dark") ? "light" : "dark"); applyTheme(); }); $("#logoutButton").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); showAuthentication(); }); document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
applyTheme(); api("/me").then(startApp).catch(showAuthentication); refreshIcons();