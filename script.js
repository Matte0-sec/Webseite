const STORAGE_KEY = "connectchat-offline-v1";
const state = { me: null, data: null, active: null };
const $ = (selector) => document.querySelector(selector);
const app = $("#appView");

function createId() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function createStore() { return { profile: null, contacts: [], chats: [], groups: [] }; }
function loadStore() {
  try {
    return { ...createStore(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") };
  } catch {
    return createStore();
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  } catch {
    toast("Der lokale Speicher ist voll. Bitte entferne ein grosses Profil- oder Gruppenbild.");
  }
}
function refreshIcons() { window.lucide?.createIcons(); }
function escapeHtml(value = "") { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function initials(name = "?") { return name.split(/[._ -]/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase(); }
function avatar(user, size = "") { return user.profileImage ? `<img class="avatar ${size}" src="${user.profileImage}" alt="">` : `<span class="avatar ${size}">${escapeHtml(initials(user.username || user.name))}</span>`; }
function now() { return new Date().toISOString(); }
function displayTime(value) { if (!value) return ""; const date = new Date(value); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); }
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("visible"); clearTimeout(window.toastTimeout); window.toastTimeout = setTimeout(() => element.classList.remove("visible"), 3200); }

function setProfile(profile) {
  state.data.profile = profile;
  state.me = profile;
  saveStore();
}
function enterApp() {
  state.me = state.data.profile;
  $("#authView").classList.add("hidden");
  app.classList.remove("hidden");
  renderProfile();
  activateView("chats");
  refreshIcons();
}
function showProfileSetup() {
  state.active = null;
  app.classList.add("hidden");
  $("#authView").classList.remove("hidden");
  $("#loginUsername").value = "";
  $("#loginStatus").value = "";
  $("#loginUsername").focus();
}
function renderProfile() {
  $("#ownProfile").innerHTML = `${avatar(state.me, "large")}<div class="profile-copy"><strong>${escapeHtml(state.me.username)}</strong><span>${escapeHtml(state.me.status || "Lokal gespeichert")}</span></div>`;
}
function activateView(view) {
  document.querySelectorAll(".content-view").forEach((node) => node.classList.add("hidden"));
  $(`#${view}View`).classList.remove("hidden");
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (view === "chats") renderConversations();
  if (view === "people") renderPeople();
  if (view === "groups") renderGroups();
}

function chatForContact(contactId) { return state.data.chats.find((chat) => chat.contactId === contactId); }
function contactForChat(chat) { return state.data.contacts.find((contact) => contact.id === chat.contactId); }
function renderConversations() {
  const container = $("#conversationList");
  const chats = [...state.data.chats].sort((first, second) => (second.messages.at(-1)?.createdAt || second.createdAt).localeCompare(first.messages.at(-1)?.createdAt || first.createdAt));
  if (!chats.length) {
    container.innerHTML = `<p class="empty-state">Noch keine lokalen Nachrichten. Lege unter Personen eine Unterhaltung an.</p>`;
    return;
  }
  container.innerHTML = chats.map((chat) => {
    const contact = contactForChat(chat);
    const last = chat.messages.at(-1);
    if (!contact) return "";
    return `<button class="conversation-item ${state.active?.kind === "chat" && state.active.id === chat.id ? "active" : ""}" data-chat="${chat.id}">${avatar(contact)}<div class="item-copy"><div class="item-title-row"><strong>${escapeHtml(contact.username)}</strong><time>${displayTime(last?.createdAt)}</time></div><span class="preview">${escapeHtml(last?.body || "Noch keine Nachrichten")}</span></div></button>`;
  }).join("");
  container.querySelectorAll("[data-chat]").forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chat)));
}
function openChat(chatId) {
  const chat = state.data.chats.find((item) => item.id === chatId);
  const contact = chat && contactForChat(chat);
  if (!chat || !contact) return;
  state.active = { kind: "chat", id: chat.id, title: contact.username, subtitle: contact.status || "Lokale Unterhaltung", profileImage: contact.profileImage };
  renderChat(chat.messages);
  app.classList.add("chat-open");
  renderConversations();
}

function renderPeople() {
  const query = $("#userSearch").value.trim().toLocaleLowerCase("de-DE");
  const container = $("#searchResults");
  const matches = state.data.contacts.filter((contact) => contact.username.toLocaleLowerCase("de-DE").includes(query));
  const exact = state.data.contacts.some((contact) => contact.username.toLocaleLowerCase("de-DE") === query);
  const canCreate = query.length >= 2 && !exact && query !== state.me.username.toLocaleLowerCase("de-DE");
  if (!query) {
    container.className = "person-list";
    container.innerHTML = matches.length ? matches.map(personRow).join("") : `<p class="empty-state">Gib einen Namen ein, um eine lokale Unterhaltung anzulegen.</p>`;
  } else {
    container.className = "person-list";
    container.innerHTML = `${canCreate ? `<article class="person-item"><span class="avatar"><i data-lucide="user-plus"></i></span><div class="item-copy"><strong>${escapeHtml($("#userSearch").value.trim())}</strong><span class="preview">Neue lokale Unterhaltung</span></div><button class="primary-button" data-create-contact="${escapeHtml($("#userSearch").value.trim())}">Anlegen</button></article>` : ""}${matches.map(personRow).join("")}` || `<p class="empty-state">Der Name muss mindestens zwei Zeichen haben.</p>`;
  }
  container.querySelectorAll("[data-contact]").forEach((button) => button.addEventListener("click", () => createOrOpenChat(button.dataset.contact)));
  container.querySelectorAll("[data-create-contact]").forEach((button) => button.addEventListener("click", () => createOrOpenChat(button.dataset.createContact)));
  refreshIcons();
}
function personRow(contact) { return `<article class="person-item">${avatar(contact)}<div class="item-copy"><strong>${escapeHtml(contact.username)}</strong><span class="preview">${escapeHtml(contact.status || "Lokaler Kontakt")}</span></div><button class="primary-button" data-contact="${contact.id}">Chat</button></article>`; }
function createOrOpenChat(contactReference) {
  let contact = state.data.contacts.find((item) => item.id === contactReference);
  if (!contact) {
    const username = String(contactReference).trim();
    if (username.length < 2) return;
    contact = { id: createId(), username, status: "Lokaler Kontakt", profileImage: "" };
    state.data.contacts.push(contact);
  }
  let chat = chatForContact(contact.id);
  if (!chat) {
    chat = { id: createId(), contactId: contact.id, createdAt: now(), messages: [] };
    state.data.chats.push(chat);
  }
  saveStore();
  $("#userSearch").value = "";
  activateView("chats");
  openChat(chat.id);
}

function renderGroups() {
  const container = $("#groupList");
  if (!state.data.groups.length) {
    container.innerHTML = `<p class="empty-state">Noch keine lokale Gruppe. Erstelle eine fuer deine Notizen und Ideen.</p>`;
    return;
  }
  container.innerHTML = state.data.groups.map((group) => `<article class="group-card">${avatar({ username: group.name, profileImage: group.image })}<div class="item-copy"><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.description || "Lokale Gruppe")}</p></div><button class="primary-button" data-group="${group.id}">Oeffnen</button></article>`).join("");
  container.querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => openGroup(button.dataset.group)));
}
function openGroup(groupId) {
  const group = state.data.groups.find((item) => item.id === groupId);
  if (!group) return;
  state.active = { kind: "group", id: group.id, title: group.name, subtitle: "Lokale Gruppe", profileImage: group.image, description: group.description };
  renderChat(group.messages);
  app.classList.add("chat-open");
}
function activeMessages() {
  if (!state.active) return [];
  return state.active.kind === "chat" ? state.data.chats.find((chat) => chat.id === state.active.id)?.messages : state.data.groups.find((group) => group.id === state.active.id)?.messages;
}
function renderChat(messages) {
  const active = state.active;
  $("#chatEmpty").classList.add("hidden");
  $("#activeChat").classList.remove("hidden");
  const tools = active.kind === "group" ? `<div class="header-tools"><button id="manageGroupButton" class="icon-button" title="Gruppe verwalten" aria-label="Gruppe verwalten"><i data-lucide="settings-2"></i></button></div>` : "";
  $("#chatHeader").innerHTML = `<button id="backButton" class="icon-button back-button" aria-label="Zurueck"><i data-lucide="arrow-left"></i></button>${avatar({ username: active.title, profileImage: active.profileImage }, "large")}<div><strong>${escapeHtml(active.title)}</strong><span>${escapeHtml(active.subtitle)}</span></div>${tools}`;
  const feed = $("#messages");
  feed.innerHTML = messages.map((message) => `<article class="message own"><p>${escapeHtml(message.body)}</p><time>${displayTime(message.createdAt)}</time></article>`).join("");
  feed.scrollTop = feed.scrollHeight;
  $("#messageInput").disabled = false;
  $("#backButton")?.addEventListener("click", () => app.classList.remove("chat-open"));
  $("#manageGroupButton")?.addEventListener("click", openManagement);
  refreshIcons();
}
function sendMessage(event) {
  event.preventDefault();
  const input = $("#messageInput");
  const body = input.value.trim();
  const messages = activeMessages();
  if (!body || !messages) return;
  messages.push({ id: createId(), body, createdAt: now() });
  input.value = "";
  saveStore();
  renderChat(messages);
  if (state.active.kind === "chat") renderConversations();
}

function imageAsDataUrl(input) {
  return new Promise((resolve, reject) => {
    const file = input.files[0];
    if (!file) return resolve("");
    if (file.size > 500000) return reject(new Error("Das Bild darf hoechstens 500 KB gross sein."));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Das Bild konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}
async function createGroup(event) {
  event.preventDefault();
  const name = $("#groupName").value.trim();
  if (name.length < 3) return;
  try {
    state.data.groups.push({ id: createId(), name, description: $("#groupDescription").value.trim(), image: await imageAsDataUrl($("#groupImage")), createdAt: now(), messages: [] });
    saveStore();
    event.target.reset();
    $("#groupDialog").close();
    activateView("groups");
    toast("Lokale Gruppe wurde erstellt.");
  } catch (error) { toast(error.message); }
}
async function saveProfile(event) {
  event.preventDefault();
  try {
    const image = await imageAsDataUrl($("#profileImage"));
    setProfile({ ...state.me, status: $("#profileStatus").value.trim(), profileImage: image || state.me.profileImage });
    renderProfile();
    $("#profileDialog").close();
    toast("Profil lokal gespeichert.");
  } catch (error) { toast(error.message); }
}
function openProfile() {
  $("#profileUsername").value = state.me.username;
  $("#profileStatus").value = state.me.status || "";
  $("#profileImage").value = "";
  $("#profileDialog").showModal();
}
function openManagement() {
  const group = state.data.groups.find((item) => item.id === state.active?.id);
  if (!group) return;
  $("#manageTitle").textContent = group.name;
  $("#editGroupName").value = group.name;
  $("#editGroupDescription").value = group.description || "";
  $("#requestList").innerHTML = `<small>Diese Gruppe existiert nur in deinem Browser.</small>`;
  $("#memberList").innerHTML = `<div class="manage-row"><span>${escapeHtml(state.me.username)} <small>Besitzer</small></span></div>`;
  $("#manageDialog").showModal();
}
function saveGroupEdit(event) {
  event.preventDefault();
  const group = state.data.groups.find((item) => item.id === state.active?.id);
  if (!group) return;
  group.name = $("#editGroupName").value.trim();
  group.description = $("#editGroupDescription").value.trim();
  state.active.title = group.name;
  state.active.description = group.description;
  saveStore();
  renderChat(group.messages);
  renderGroups();
  toast("Gruppe lokal aktualisiert.");
}
function removeGroup() {
  if (!state.active || !confirm("Diese lokale Gruppe wirklich loeschen?")) return;
  state.data.groups = state.data.groups.filter((group) => group.id !== state.active.id);
  state.active = null;
  saveStore();
  $("#manageDialog").close();
  $("#activeChat").classList.add("hidden");
  $("#chatEmpty").classList.remove("hidden");
  app.classList.remove("chat-open");
  renderGroups();
  toast("Gruppe geloescht.");
}
function applyTheme() { document.body.classList.toggle("dark", localStorage.getItem("connectchat-theme") === "dark"); }

$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const username = $("#loginUsername").value.trim();
  if (username.length < 3) return;
  setProfile({ id: "local-user", username, status: $("#loginStatus").value.trim(), profileImage: "" });
  enterApp();
});
$("#newChatButton").addEventListener("click", () => activateView("people"));
$("#createGroupButton").addEventListener("click", () => $("#groupDialog").showModal());
$("#groupForm").addEventListener("submit", createGroup);
$("#profileButton").addEventListener("click", openProfile);
$("#profileForm").addEventListener("submit", saveProfile);
$("#messageForm").addEventListener("submit", sendMessage);
$("#editGroupForm").addEventListener("submit", saveGroupEdit);
$("#deleteGroupButton").addEventListener("click", removeGroup);
$("#userSearch").addEventListener("input", renderPeople);
$("#themeButton").addEventListener("click", () => { localStorage.setItem("connectchat-theme", document.body.classList.contains("dark") ? "light" : "dark"); applyTheme(); });
$("#logoutButton").addEventListener("click", () => { state.data.profile = null; saveStore(); showProfileSetup(); });
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

state.data = loadStore();
applyTheme();
if (state.data.profile?.username) enterApp(); else showProfileSetup();
refreshIcons();