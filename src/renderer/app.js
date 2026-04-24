/**
 * Portulus renderer — UI logic.
 */

const api = window.portulus;
if(!api){
    document.body.innerHTML = `<div style="color:#e74c3c;padding:40px;font-family:monospace;">
        <h2>Preload failed</h2>
        <p>window.portulus is not available. The preload script did not load correctly.</p>
    </div>`;
    throw new Error("window.portulus not available — preload.cjs failed to load");
}

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

const state = {
    nick: "anon",
    suffix: "",
    channels: {},   // cid -> { name, hub, key, cid, protocol: "lxcf"|"rrc", messages: [], members: [] }
    activeCid: null,
    hubs: { hubs: {} },  // hub-centric bookmarks from bookmarks.json
    revealHubs: false,
    rrcConnections: {},  // hubHash -> { hubName, limits, rooms: Set }
    discoveredHubs: [],  // [{ hash, name }] — from rrc:hub_discovered events
    rrcActiveHubTag: null,  // tag of the currently connected RRC hub
    rrcActiveHubDest: null, // destination hash of the currently connected RRC hub
    rrcHubs: { hubs: {} },  // RRC bookmarks from ~/.portulus/bookmarks.json
};

// ------------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------------

const $tabs = document.getElementById("tabs");
const $btnJoin = document.getElementById("btn-join");
const $splash = document.getElementById("splash");
const $splashBookmarks = document.getElementById("splash-bookmarks");
const $splashInput = document.getElementById("splash-input");
const $main = document.getElementById("main");
const $messages = document.getElementById("messages");
const $sidebar = document.getElementById("sidebar");
const $selfNick = document.getElementById("self-nick");
const $memberList = document.getElementById("member-list");
const $inputBar = document.getElementById("input-bar");
const $input = document.getElementById("input");
const $statusIdentity = document.getElementById("status-identity");
const $titleLabel = document.getElementById("titlebar-label");

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function displayNick(nick, suffix) {
    return suffix ? `${nick}~${suffix}` : nick;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function scrollToBottom() {
    $messages.scrollTop = $messages.scrollHeight;
}

// ------------------------------------------------------------------
// Tab management
// ------------------------------------------------------------------

function renderTabs() {
    $tabs.innerHTML = "";
    for(const [cid, ch] of Object.entries(state.channels)){
        const tab = document.createElement("div");
        tab.className = "tab" + (cid === state.activeCid ? " active" : "");
        tab.dataset.cid = cid;

        const isBookmarked = isChannelBookmarked(ch.name, ch.hub, ch.key, ch.hubDest);
        const star = isBookmarked ? "★" : "☆";
        const protoIcon = ch.protocol === "rrc" ? "◈" : "⬡";
        let label;
        if(ch.protocol === "rrc"){
            // For RRC: always show hub context
            let hubLabel = ch.hub;
            if(!hubLabel && ch.hubDest){
                const found = findRrcHubByDest(ch.hubDest);
                if(found) hubLabel = found.tag;
            }
            if(!hubLabel){
                // Try to find a name from active connections
                for(const conn of Object.values(state.rrcConnections)){
                    if(conn.hubName){ hubLabel = conn.hubName; break; }
                }
            }
            label = hubLabel ? `${hubLabel}:${ch.name}` : ch.name;
        } else if(state.revealHubs){
            label = ch.hub ? `${ch.hub}:${ch.name}` : ch.name;
        } else {
            label = ch.name;
        }
        tab.innerHTML = `<span class="tab-star${isBookmarked ? " bookmarked" : ""}">${star}</span><span>${protoIcon} ${escapeHtml(label)}</span><span class="close-tab">×</span>`;

        tab.addEventListener("click", (e) => {
            if(e.target.classList.contains("close-tab")){
                leaveChannel(cid);
            } else if(e.target.classList.contains("tab-star")){
                if(ch.protocol === "rrc"){
                    // Resolve hub tag from destination hash (source of truth)
                    const found = ch.hubDest ? findRrcHubByDest(ch.hubDest) : null;
                    const rrcHubTag = found ? found.tag : (ch.hub || findRrcHubTag());
                    api.rrcToggleBookmark(ch.name, rrcHubTag).then(result => {
                        state.rrcHubs = result.hubs || result;
                        renderTabs();
                    });
                } else {
                    api.toggleBookmark(ch.name, ch.hub, ch.key).then(result => {
                        state.hubs = result.hubs || result;
                        renderTabs();
                    });
                }
            } else {
                switchTab(cid);
            }
        });

        $tabs.appendChild(tab);
    }
}

function isChannelBookmarked(name, hubTag, key, hubDest) {
    const tag = hubTag || "local";
    // Check LXCF bookmarks
    const lxcfHub = (state.hubs.hubs || {})[tag];
    if(lxcfHub){
        if((lxcfHub.channels || []).some(ch => ch.name === name && (ch.key ?? null) === (key ?? null))){
            return true;
        }
    }
    // Check RRC bookmarks — match by destination hash (source of truth)
    if(hubDest){
        const found = findRrcHubByDest(hubDest);
        if(found && (found.hub.channels || []).some(ch => ch.name === name)){
            return true;
        }
    }
    // Fallback: match by tag name
    if(hubTag){
        const rrcHub = (state.rrcHubs.hubs || {})[hubTag];
        if(rrcHub && (rrcHub.channels || []).some(ch => ch.name === name)){
            return true;
        }
    }
    return false;
}

// Helper: find RRC hub tag by destination hash
function findRrcHubByDest(dest) {
    if(!dest) return null;
    const lc = dest.toLowerCase();
    for(const [tag, hub] of Object.entries(state.rrcHubs.hubs || {})){
        if((hub.destination || "").toLowerCase() === lc) return { tag, hub };
    }
    return null;
}

function findRrcHubTag() {
    const hubs = state.rrcHubs.hubs || {};
    for(const [tag, hub] of Object.entries(hubs)){
        return tag;
    }
    return null;
}

function switchTab(cid) {
    state.activeCid = cid;
    renderTabs();
    renderMessages();
    renderMembers();
}

function showChat() {
    $splash.classList.add("hidden");
    $main.classList.remove("hidden");
    $inputBar.classList.remove("hidden");
    $input.focus();
}

function showSplash() {
    $splash.classList.remove("hidden");
    $main.classList.add("hidden");
    $inputBar.classList.add("hidden");
    renderBookmarks();
}

// ------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------

function addMessage(cid, html) {
    const ch = state.channels[cid];
    if(!ch) return;
    ch.messages.push(html);

    if(cid === state.activeCid){
        const line = document.createElement("div");
        line.className = "msg-line";
        line.innerHTML = html;
        $messages.appendChild(line);
        scrollToBottom();
    }
}

function renderMessages() {
    $messages.innerHTML = "";
    const ch = state.channels[state.activeCid];
    if(!ch) return;

    for(const html of ch.messages){
        const line = document.createElement("div");
        line.className = "msg-line";
        line.innerHTML = html;
        $messages.appendChild(line);
    }
    scrollToBottom();
}

function renderMembers() {
    const ch = state.channels[state.activeCid];
    if(!ch) {
        $selfNick.textContent = "";
        $memberList.innerHTML = "";
        return;
    }

    $selfNick.textContent = displayNick(state.nick, state.suffix);

    $memberList.innerHTML = "";
    const sorted = [...ch.members].sort((a, b) => a.nick.localeCompare(b.nick));
    for(const m of sorted){
        if(m.isSelf) continue;
        const div = document.createElement("div");
        div.className = "member";
        div.textContent = displayNick(m.nick, m.suffix);
        $memberList.appendChild(div);
    }
}

// ------------------------------------------------------------------
// Bookmarks
// ------------------------------------------------------------------

function renderBookmarks() {
    $splashBookmarks.innerHTML = "";

    // --- LXCF hubs (from ~/.lxcf/bookmarks.json via LXCF bridge) ---
    const lxcfHubs = state.hubs.hubs || {};
    for(const tag of Object.keys(lxcfHubs).sort()){
        const hub = lxcfHubs[tag];
        const channels = hub.channels || [];

        const header = document.createElement("div");
        header.className = "bookmark-header";
        header.innerHTML = `${escapeHtml(tag === "local" ? "🌐 Local" : `⬡ ${tag}`)}`;
        header.style.cursor = "pointer";
        header.addEventListener("click", () => openHubModal(tag));
        $splashBookmarks.appendChild(header);

        if(channels.length === 0){
            const empty = document.createElement("div");
            empty.className = "bookmark-item";
            empty.style.color = "var(--text-dim)";
            empty.style.fontSize = "12px";
            empty.innerHTML = `<span class="bookmark-icon">·</span><span>No bookmarked channels</span>`;
            $splashBookmarks.appendChild(empty);
            continue;
        }

        for(const ch of [...channels].sort((a, b) => a.name.localeCompare(b.name))){
            const item = document.createElement("div");
            item.className = "bookmark-item";
            item.innerHTML = `<span class="bookmark-icon">⬡</span><span>${escapeHtml(ch.name)}</span>`;
            item.addEventListener("click", () => {
                const hubArg = (tag === "local" && !hub.destination) ? null : tag;
                joinChannel(ch.name, hubArg, ch.key);
            });
            $splashBookmarks.appendChild(item);
        }
    }

    // --- RRC hubs (from ~/.portulus/bookmarks.json via RRC bridge) ---
    const rrcHubs = state.rrcHubs.hubs || {};
    for(const tag of Object.keys(rrcHubs).sort()){
        const hub = rrcHubs[tag];
        const channels = hub.channels || [];

        const header = document.createElement("div");
        header.className = "bookmark-header";
        header.innerHTML = `◈ ${escapeHtml(tag)}`;
        header.style.cursor = "pointer";
        header.addEventListener("click", () => openRrcHubModal(tag));
        $splashBookmarks.appendChild(header);

        if(channels.length === 0){
            const empty = document.createElement("div");
            empty.className = "bookmark-item";
            empty.style.color = "var(--text-dim)";
            empty.style.fontSize = "12px";
            empty.style.cursor = "pointer";
            empty.innerHTML = `<span class="bookmark-icon">·</span><span>No bookmarked rooms — click to join</span>`;
            const hubTag = tag;
            const hubDest = hub.destination || hubTag;
            empty.addEventListener("click", () => {
                const prefix = "/join #";
                const suffix = ` ${hubDest}`;
                $splashInput.value = prefix + suffix;
                $splashInput.focus();
                $splashInput.setSelectionRange(prefix.length, prefix.length);
                // Force scroll so the cursor (near the start) is visible
                $splashInput.scrollLeft = 0;
            });
            $splashBookmarks.appendChild(empty);
            continue;
        }

        for(const ch of [...channels].sort((a, b) => a.name.localeCompare(b.name))){
            const item = document.createElement("div");
            item.className = "bookmark-item";
            item.innerHTML = `<span class="bookmark-icon">◈</span><span>${escapeHtml(ch.name)}</span>`;
            item.addEventListener("click", () => {
                const dest = hub.destination;
                const destName = hub.dest_name || null;
                if(dest){
                    if(state.rrcConnections[dest]){
                        api.rrcJoin(ch.name).catch(console.error);
                    } else {
                        api.rrcConnectHub(dest, destName).then(() => {
                            api.rrcJoin(ch.name);
                        }).catch(console.error);
                    }
                }
            });
            $splashBookmarks.appendChild(item);
        }
    }

    // Add hub button
    const addBtn = document.createElement("div");
    addBtn.className = "bookmark-item";
    addBtn.style.color = "var(--text-dim)";
    addBtn.style.marginTop = "8px";
    addBtn.innerHTML = `<span class="bookmark-icon">+</span><span>Add hub</span>`;
    addBtn.addEventListener("click", () => openHubModal(null));
    $splashBookmarks.appendChild(addBtn);

    // --- Discovered RRC hubs (below Add hub to avoid UI shifts) ---
    if(state.discoveredHubs.length > 0){
        const savedHashes = new Set(
            Object.values(rrcHubs).map(h => (h.destination || "").toLowerCase()).filter(Boolean)
        );

        const unsaved = state.discoveredHubs.filter(d => !savedHashes.has(d.hash.toLowerCase()));
        if(unsaved.length > 0){
            const header = document.createElement("div");
            header.className = "bookmark-header";
            header.style.marginTop = "12px";
            header.innerHTML = `◈ Discovered`;
            $splashBookmarks.appendChild(header);

            for(const dHub of unsaved){
                const label = dHub.name
                    ? `${escapeHtml(dHub.name)} <span style="opacity:0.5">${escapeHtml(dHub.hash.slice(0, 12))}…</span>`
                    : `<span style="font-family:monospace">${escapeHtml(dHub.hash.slice(0, 24))}…</span>`;

                const item = document.createElement("div");
                item.className = "bookmark-item";
                item.innerHTML = `<span class="bookmark-icon">◈</span><span>${label}</span><button class="discover-add" title="Save as hub">+</button>`;

                item.querySelector(".discover-add").addEventListener("click", (e) => {
                    e.stopPropagation();
                    openRrcHubModal(null, dHub.hash, dHub.name);
                });

                item.addEventListener("click", (e) => {
                    if(e.target.closest(".discover-add")) return;
                    api.rrcConnectHub(dHub.hash, null).catch(console.error);
                });

                $splashBookmarks.appendChild(item);
            }
        }
    }
}

// ------------------------------------------------------------------
// Hub edit modal
// ------------------------------------------------------------------

function openHubModal(tag) {
    const $modal = document.getElementById("hub-modal");
    const $tag = document.getElementById("hub-modal-tag");
    const $dest = document.getElementById("hub-modal-dest");
    const $channel = document.getElementById("hub-modal-channel");
    const $title = document.getElementById("hub-modal-title");
    const $del = document.getElementById("hub-modal-delete");
    const $destname = document.getElementById("hub-modal-destname");
    const $destnameRow = document.getElementById("hub-modal-destname-row");
    const protoBtns = document.querySelectorAll("#hub-modal-protocol .proto-btn");

    if(tag){
        const hub = (state.hubs.hubs || {})[tag] || {};
        $title.textContent = "Edit Hub";
        $tag.value = tag;
        $dest.value = hub.destination || "";
        $channel.value = (hub.channels || [])[0]?.name || "";
        $destname.value = hub.dest_name || "";
        $del.classList.remove("hidden");
        $modal.dataset.protocol = hub.protocol || "lxcf";
    } else {
        $title.textContent = "Add Hub";
        $tag.value = "";
        $dest.value = "";
        $channel.value = "";
        $destname.value = "";
        $del.classList.add("hidden");
        $modal.dataset.protocol = "lxcf";
    }

    // Sync protocol toggle buttons and dest_name visibility
    const proto = $modal.dataset.protocol;
    protoBtns.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.proto === proto);
    });
    $destnameRow.classList.toggle("hidden", proto !== "rrc");

    $modal.classList.remove("hidden");
    $tag.focus();
}

function closeHubModal() {
    document.getElementById("hub-modal").classList.add("hidden");
}

function openRrcHubModal(tag, prefillHash, prefillName) {
    const $modal = document.getElementById("hub-modal");
    const $tag = document.getElementById("hub-modal-tag");
    const $dest = document.getElementById("hub-modal-dest");
    const $channel = document.getElementById("hub-modal-channel");
    const $title = document.getElementById("hub-modal-title");
    const $del = document.getElementById("hub-modal-delete");
    const $destname = document.getElementById("hub-modal-destname");
    const $destnameRow = document.getElementById("hub-modal-destname-row");
    const protoBtns = document.querySelectorAll("#hub-modal-protocol .proto-btn");

    if(tag){
        const hub = (state.rrcHubs.hubs || {})[tag] || {};
        $title.textContent = "Edit RRC Hub";
        $tag.value = tag;
        $dest.value = hub.destination || "";
        $channel.value = (hub.channels || [])[0]?.name || "";
        $destname.value = hub.dest_name || "";
        $del.classList.remove("hidden");
    } else {
        $title.textContent = "Add RRC Hub";
        $tag.value = prefillName || (prefillHash ? prefillHash.slice(0, 12) : "");
        $dest.value = prefillHash || "";
        $channel.value = "";
        $destname.value = "";
        $del.classList.add("hidden");
    }

    $modal.dataset.protocol = "rrc";
    protoBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.proto === "rrc"));
    $destnameRow.classList.remove("hidden");
    $modal.classList.remove("hidden");
    $tag.focus();
}

// Protocol toggle in hub modal
document.getElementById("hub-modal-protocol").addEventListener("click", (e) => {
    const btn = e.target.closest(".proto-btn");
    if(!btn) return;
    const $modal = document.getElementById("hub-modal");
    $modal.dataset.protocol = btn.dataset.proto;
    document.querySelectorAll("#hub-modal-protocol .proto-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.proto === btn.dataset.proto);
    });
    document.getElementById("hub-modal-destname-row").classList.toggle("hidden", btn.dataset.proto !== "rrc");
});

document.getElementById("hub-modal-save").addEventListener("click", async () => {
    const tag = document.getElementById("hub-modal-tag").value.trim();
    const dest = document.getElementById("hub-modal-dest").value.trim() || null;
    const channel = document.getElementById("hub-modal-channel").value.trim() || null;
    const protocol = document.getElementById("hub-modal").dataset.protocol || "lxcf";
    const destName = document.getElementById("hub-modal-destname").value.trim() || null;
    if(!tag) return;

    if(protocol === "rrc"){
        const result = await api.rrcSaveHub(tag, dest, destName);
        state.rrcHubs = result.hubs || result;
        // Add home channel as a bookmark if provided
        if(channel){
            const chName = channel.startsWith("#") ? channel : `#${channel}`;
            const result2 = await api.rrcToggleBookmark(chName, tag);
            // Only update if it was added (not toggled off)
            const hubEntry = (result2.hubs || result2).hubs?.[tag];
            if(hubEntry && (hubEntry.channels || []).some(c => c.name === chName)){
                state.rrcHubs = result2.hubs || result2;
            }
        }
    } else {
        const result = await api.saveHub(tag, dest);
        state.hubs = result.hubs || result;
        if(channel){
            const chName = channel.startsWith("#") ? channel : `#${channel}`;
            const result2 = await api.toggleBookmark(chName, tag, null);
            state.hubs = result2.hubs || result2;
        }
    }
    closeHubModal();
    renderBookmarks();
    renderTabs();
});

document.getElementById("hub-modal-delete").addEventListener("click", async () => {
    const tag = document.getElementById("hub-modal-tag").value.trim();
    const protocol = document.getElementById("hub-modal").dataset.protocol || "lxcf";
    if(!tag) return;

    if(protocol === "rrc"){
        const result = await api.rrcDeleteHub(tag);
        state.rrcHubs = result.hubs || result;
    } else {
        const result = await api.deleteHub(tag);
        state.hubs = result.hubs || result;
    }
    closeHubModal();
    renderBookmarks();
    renderTabs();
});

document.getElementById("hub-modal-cancel").addEventListener("click", closeHubModal);

document.querySelector("#hub-modal .modal-backdrop").addEventListener("click", closeHubModal);

// ------------------------------------------------------------------
// Channel actions
// ------------------------------------------------------------------

async function joinChannel(name, hub, key) {
    if(!name.startsWith("#")) name = "#" + name;

    // already joined — just switch to it
    for(const [cid, ch] of Object.entries(state.channels)){
        if(ch.name === name && (ch.hub ?? null) === (hub ?? null) && (ch.key ?? null) === (key ?? null)){
            state.activeCid = cid;
            renderTabs();
            showChat();
            renderMessages();
            renderMembers();
            return;
        }
    }

    try {
        const result = await api.join(name, hub || null, key || null);
        if(!result.ok){
            throw new Error(result.error || "Join failed");
        }
        const cid = result.cid;

        if(!cid){
            throw new Error("Bridge returned no channel ID");
        }

        if(!state.channels[cid]){
            state.channels[cid] = {
                name: result.name,
                hub: result.hub,
                key: result.key,
                messages: [],
                members: [],
            };
        }

        const displayName = result.name || name;
        if(result.destHash){
            addMessage(cid, `<span class="msg-system"><span class="msg-join">Joined ${escapeHtml(displayName)}.</span><br>Destination: ${result.destHash}</span>`);
        } else {
            addMessage(cid, `<span class="msg-system msg-join">Joined ${escapeHtml(displayName)}</span>`);
        }

        state.activeCid = cid;
        renderTabs();
        showChat();
        renderMessages();
        renderMembers();
    } catch(err) {
        console.error("joinChannel failed:", err);
        // show error on splash if no active channel
        if(!state.activeCid){
            const errDiv = document.createElement("div");
            errDiv.className = "msg-system";
            errDiv.style.color = "var(--danger)";
            errDiv.style.marginTop = "8px";
            errDiv.style.fontSize = "12px";
            errDiv.textContent = `Failed to join: ${err.message || err}`;
            document.getElementById("splash-join").appendChild(errDiv);
            setTimeout(() => errDiv.remove(), 5000);
        }
    }
}

async function leaveChannel(cid) {
    await api.leave(cid);
    delete state.channels[cid];

    if(state.activeCid === cid){
        const remaining = Object.keys(state.channels);
        state.activeCid = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }

    renderTabs();
    if(state.activeCid){
        renderMessages();
        renderMembers();
    } else {
        showSplash();
    }
}

// ------------------------------------------------------------------
// Input handling
// ------------------------------------------------------------------

function handleInput(line) {
    if(!line) return;
    const cid = state.activeCid;

    if(line.startsWith("/join ")){
        const parts = line.slice(6).trim().split(/\s+/, 3);
        const name = parts[0] || "";
        const hub = parts[1] || null;
        const key = parts[2] || null;

        // Inherit hub from active tab when not specified
        const activeCh = state.activeCid ? state.channels[state.activeCid] : null;
        const effectiveHub = hub || (activeCh?.hub || null);

        // Check if this should route to RRC
        let hubEntry = effectiveHub ? (state.rrcHubs.hubs || {})[effectiveHub] : null;
        let rrcDest = hubEntry ? hubEntry.destination : null;
        let rrcDestName = hubEntry ? (hubEntry.dest_name || null) : null;

        if(!hubEntry && effectiveHub && /^[0-9a-f]{16,}$/i.test(effectiveHub)){
            // Hub argument looks like a hex hash — find matching RRC hub by destination
            for(const [t, h] of Object.entries(state.rrcHubs.hubs || {})){
                if((h.destination || "").toLowerCase() === effectiveHub.toLowerCase()){
                    hubEntry = h;
                    rrcDest = h.destination;
                    rrcDestName = h.dest_name || null;
                    break;
                }
            }
            if(!hubEntry){
                rrcDest = effectiveHub;
            }
        }

        // If active tab is RRC and we still don't have a dest, inherit from connection
        if(!rrcDest && activeCh && activeCh.protocol === "rrc" && !hub){
            // Find the dest from active RRC connections
            for(const [connHash, conn] of Object.entries(state.rrcConnections)){
                rrcDest = connHash;
                rrcDestName = null;
                break;
            }
        }

        const isRrc = !!rrcDest;

        if(isRrc && rrcDest){
            // If already connected to this hub, just join the room
            const alreadyConnected = state.rrcConnections[rrcDest] || state.rrcConnections[rrcDest?.toLowerCase()];
            if(alreadyConnected){
                api.rrcJoin(name).catch(console.error);
            } else {
                api.rrcConnectHub(rrcDest, rrcDestName).then(() => {
                    api.rrcJoin(name);
                }).catch(console.error);
            }
        } else if(name){
            joinChannel(name, effectiveHub, key).catch(console.error);
        }

    } else if(line.startsWith("/leave")){
        if(cid){
            const ch = state.channels[cid];
            if(ch && ch.protocol === "rrc"){
                api.rrcLeave(ch.name);
                delete state.channels[cid];
                const remaining = Object.keys(state.channels);
                state.activeCid = remaining.length > 0 ? remaining[remaining.length - 1] : null;
                renderTabs();
                if(state.activeCid){
                    renderMessages();
                    renderMembers();
                } else {
                    showSplash();
                }
            } else {
                leaveChannel(cid);
            }
        }

    } else if(line === "/quit"){
        document.getElementById("quit-modal").classList.remove("hidden");
        document.getElementById("quit-confirm").focus();
        document.getElementById("quit-confirm").focus();

    } else if(line.startsWith("/nick ")){
        const newNick = line.slice(6).trim();
        if(newNick){
            api.changeNick(newNick);
            api.rrcChangeNick(newNick);
        }

    } else if(line.startsWith("/me ")){
        if(cid){
            api.emote(cid, line.slice(4));
            const ts = formatTime(Date.now() / 1000);
            const dn = displayNick(state.nick, state.suffix);
            addMessage(cid, `<span class="msg-time">${ts}</span><span class="msg-emote">* ${escapeHtml(dn)} ${escapeHtml(line.slice(4))}</span>`);
        }

    // } else if(line.startsWith("/topic ")){
    //     if(cid) api.setTopic(cid, line.slice(7));

    // } else if(line.startsWith("/dm ")){
    //     const parts = line.split(" ", 3);
    //     if(parts.length >= 3) api.privmsg(parts[1], parts[2]);

    } else if(line.startsWith("/")){
        if(cid) addMessage(cid, `<span class="msg-system" style="color:var(--danger)">Unknown command: ${escapeHtml(line.split(" ")[0])}</span>`);

    } else {
        if(cid){
            const ch = state.channels[cid];
            if(ch && ch.protocol === "rrc"){
                api.rrcSend(ch.name, line);
            } else {
                api.send(cid, line);
            }
            // show own message immediately
            const ts = formatTime(Date.now() / 1000);
            const dn = displayNick(state.nick, state.suffix);
            addMessage(cid, `<span class="msg-time">${ts}</span><span class="msg-nick">&lt;${escapeHtml(dn)}&gt;</span> <span class="msg-body">${escapeHtml(line)}</span>`);
        }
    }
}

// ------------------------------------------------------------------
// Command autocomplete
// ------------------------------------------------------------------

const COMMANDS = [
    { name: "/join",  hint: "#channel [hub] [key]", args: true },
    { name: "/leave", hint: "leave current channel", args: false },
    { name: "/quit",  hint: "exit portulus", args: false },
    { name: "/nick",  hint: "new_name", args: true },
    { name: "/me",    hint: "action text", args: true },
];

const $cmdMenu = document.getElementById("cmd-menu");
let cmdActiveIdx = -1;

function updateCmdMenu() {
    const val = $input.value;
    if(!val.startsWith("/") || val.includes(" ")){
        $cmdMenu.classList.add("hidden");
        cmdActiveIdx = -1;
        return;
    }

    const query = val.toLowerCase();
    const matches = COMMANDS.filter(c => c.name.startsWith(query));

    if(matches.length === 0){
        $cmdMenu.classList.add("hidden");
        cmdActiveIdx = -1;
        return;
    }

    $cmdMenu.innerHTML = "";
    cmdActiveIdx = Math.min(cmdActiveIdx, matches.length - 1);
    if(cmdActiveIdx < 0) cmdActiveIdx = 0;

    matches.forEach((cmd, i) => {
        const div = document.createElement("div");
        div.className = "cmd-item" + (i === cmdActiveIdx ? " active" : "");
        div.innerHTML = `<span class="cmd-name">${escapeHtml(cmd.name)}</span><span class="cmd-hint">${escapeHtml(cmd.hint)}</span>`;
        div.addEventListener("mousedown", (e) => {
            e.preventDefault();
            acceptCmd(cmd);
        });
        $cmdMenu.appendChild(div);
    });

    $cmdMenu.classList.remove("hidden");
}

function acceptCmd(cmd) {
    $input.value = cmd.name + (cmd.args ? " " : "");
    $cmdMenu.classList.add("hidden");
    cmdActiveIdx = -1;
    $input.focus();
    if(!cmd.args){
        const line = $input.value.trim();
        $input.value = "";
        handleInput(line);
    }
}

function getVisibleCmds() {
    const val = $input.value.toLowerCase();
    return COMMANDS.filter(c => c.name.startsWith(val));
}

// ------------------------------------------------------------------
// Event wiring — input
// ------------------------------------------------------------------

$input.addEventListener("keydown", (e) => {
    const menuVisible = !$cmdMenu.classList.contains("hidden");

    if(menuVisible){
        const matches = getVisibleCmds();
        if(e.key === "ArrowUp"){
            e.preventDefault();
            cmdActiveIdx = Math.max(0, cmdActiveIdx - 1);
            updateCmdMenu();
            return;
        }
        if(e.key === "ArrowDown"){
            e.preventDefault();
            cmdActiveIdx = Math.min(matches.length - 1, cmdActiveIdx + 1);
            updateCmdMenu();
            return;
        }
        if(e.key === "Tab" || (e.key === "Enter" && matches.length > 0 && !$input.value.includes(" "))){
            e.preventDefault();
            if(cmdActiveIdx >= 0 && cmdActiveIdx < matches.length){
                acceptCmd(matches[cmdActiveIdx]);
            }
            return;
        }
        if(e.key === "Escape"){
            $cmdMenu.classList.add("hidden");
            cmdActiveIdx = -1;
            return;
        }
    }

    if(e.key === "Enter"){
        const line = $input.value.trim();
        $input.value = "";
        $cmdMenu.classList.add("hidden");
        cmdActiveIdx = -1;
        handleInput(line);
    }
});

$input.addEventListener("input", () => {
    updateCmdMenu();
});

$splashInput.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
        const line = $splashInput.value.trim();
        $splashInput.value = "";
        handleInput(line);
    }
});

$btnJoin.addEventListener("click", () => {
    if(state.activeCid){
        $input.value = "/join ";
        $input.focus();
    } else {
        $splashInput.focus();
    }
});

const $btnReveal = document.getElementById("btn-reveal");
$btnReveal.addEventListener("click", () => {
    state.revealHubs = !state.revealHubs;
    $btnReveal.classList.toggle("active", state.revealHubs);
    renderTabs();
});

document.getElementById("splash-go").addEventListener("click", () => {
    const line = $splashInput.value.trim();
    $splashInput.value = "";
    handleInput(line);
});

document.getElementById("btn-quit").addEventListener("click", () => {
    document.getElementById("quit-modal").classList.remove("hidden");
    document.getElementById("quit-confirm").focus();
});

document.getElementById("quit-cancel").addEventListener("click", () => {
    document.getElementById("quit-modal").classList.add("hidden");
});

document.getElementById("quit-confirm").addEventListener("click", () => {
    api.quit();
});

document.querySelector("#quit-modal .modal-backdrop").addEventListener("click", () => {
    document.getElementById("quit-modal").classList.add("hidden");
});

document.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && !document.getElementById("quit-modal").classList.contains("hidden")){
        document.getElementById("quit-modal").classList.add("hidden");
    }
    if(e.key === "Escape" && !document.getElementById("hub-modal").classList.contains("hidden")){
        closeHubModal();
    }
});

document.getElementById("btn-theme").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("theme-menu");
    menu.classList.toggle("hidden");
});

// close theme menu on outside click
document.addEventListener("click", () => {
    document.getElementById("theme-menu").classList.add("hidden");
});

document.getElementById("theme-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const option = e.target.closest(".theme-option");
    if(!option) return;
    const theme = option.dataset.theme;
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-option").forEach(el => el.classList.remove("active"));
    option.classList.add("active");
    api.saveSettings({ theme });
    document.getElementById("theme-menu").classList.add("hidden");
});

// keyboard shortcuts
document.addEventListener("keydown", (e) => {
    // Ctrl+S — toggle bookmark on active tab
    if((e.ctrlKey || e.metaKey) && e.key === "s"){
        e.preventDefault();
        const ch = state.channels[state.activeCid];
        if(!ch) return;
        if(ch.protocol === "rrc"){
            const found = ch.hubDest ? findRrcHubByDest(ch.hubDest) : null;
            const rrcHubTag = found ? found.tag : (ch.hub || findRrcHubTag());
            api.rrcToggleBookmark(ch.name, rrcHubTag).then(result => {
                state.rrcHubs = result.hubs || result;
                renderTabs();
            });
        } else {
            api.toggleBookmark(ch.name, ch.hub, ch.key).then(result => {
                state.hubs = result.hubs || result;
                renderTabs();
            });
        }
    }
});

// ------------------------------------------------------------------
// Event wiring — LXCF events from main process
// ------------------------------------------------------------------

api.on("lxcf:init", (data) => {
    state.nick = data.nick;
    state.suffix = data.suffix;
    state.hubs = data.hubs || { hubs: {} };
    $statusIdentity.textContent = `${data.nick}~${data.suffix}`;
    $titleLabel.textContent = `Portulus — ${data.nick}~${data.suffix}`;
    renderBookmarks();
});

api.on("lxcf:message", (data) => {
    const ts = formatTime(data.timestamp);
    const dn = displayNick(data.nick, data.suffix);
    addMessage(data.cid, `<span class="msg-time">${ts}</span><span class="msg-nick">&lt;${escapeHtml(dn)}&gt;</span> <span class="msg-body">${escapeHtml(data.body)}</span>`);
});

api.on("lxcf:join", (data) => {
    const dn = displayNick(data.nick, data.suffix);
    addMessage(data.cid, `<span class="msg-system msg-join">→ ${escapeHtml(dn)} joined</span>`);
});

api.on("lxcf:leave", (data) => {
    const dn = displayNick(data.nick, data.suffix);
    addMessage(data.cid, `<span class="msg-system msg-leave">← ${escapeHtml(dn)} left</span>`);
});

api.on("lxcf:nick", (data) => {
    if(data.newNick){
        state.nick = data.newNick;
        $statusIdentity.textContent = `${state.nick}~${state.suffix}`;
        $titleLabel.textContent = `Portulus — ${state.nick}~${state.suffix}`;
    }
    for(const cid of Object.keys(state.channels)){
        const oldDn = displayNick(data.oldNick, data.suffix);
        const newDn = displayNick(data.newNick, data.suffix);
        addMessage(cid, `<span class="msg-system">${escapeHtml(oldDn)} is now known as ${escapeHtml(newDn)}</span>`);
    }
    renderMembers();
});

api.on("lxcf:emote", (data) => {
    const ts = formatTime(data.timestamp);
    const dn = displayNick(data.nick, data.suffix);
    addMessage(data.cid, `<span class="msg-time">${ts}</span><span class="msg-emote">* ${escapeHtml(dn)} ${escapeHtml(data.body)}</span>`);
});

api.on("lxcf:topic", (data) => {
    addMessage(data.cid, `<span class="msg-system">${escapeHtml(data.nick)} set topic: ${escapeHtml(data.body)}</span>`);
});

api.on("lxcf:privmsg", (data) => {
    const ts = formatTime(data.timestamp);
    const dn = displayNick(data.nick, data.suffix);
    // show DM in active channel
    if(state.activeCid){
        addMessage(state.activeCid, `<span class="msg-time">${ts}</span><span class="msg-dm">[DM]</span> <span class="msg-nick">&lt;${escapeHtml(dn)}&gt;</span> <span class="msg-body">${escapeHtml(data.body)}</span>`);
    }
});

api.on("lxcf:members", (data) => {
    const ch = state.channels[data.cid];
    if(ch){
        ch.members = data.members;
        if(data.cid === state.activeCid){
            renderMembers();
        }
    }
});

// ------------------------------------------------------------------
// Event wiring — RRC events from main process
// ------------------------------------------------------------------

api.on("rrc:init", (data) => {
    // RRC bridge ready — load RRC bookmarks and start hub discovery
    state.rrcHubs = data.hubs || { hubs: {} };
    renderBookmarks();
    api.rrcDiscoverHubs().catch(() => {});
});

api.on("rrc:connected", (data) => {
    const hubHash = data.hub_hash || "";
    const hubName = data.hub_name || "";

    // Find the tag for this hub in RRC bookmarks
    const hubs = state.rrcHubs.hubs || {};
    let foundTag = null;
    for(const [tag, hub] of Object.entries(hubs)){
        if(hub.destination === hubHash) { foundTag = tag; break; }
    }
    state.rrcActiveHubTag = foundTag;
    state.rrcActiveHubDest = hubHash;
    state.rrcConnections[hubHash] = {
        hubName: hubName || hubHash,
        limits: data.limits || {},
        rooms: new Set(),
    };

    // If the bookmark tag looks like a hash prefix and we got a real name
    // from WELCOME, offer to update it
    if(foundTag && hubName && /^[0-9a-f]{6,}$/i.test(foundTag)){
        // Rename the bookmark to the hub's display name
        const hubEntry = hubs[foundTag];
        delete hubs[foundTag];
        hubs[hubName] = hubEntry;
        state.rrcActiveHubTag = hubName;
        api.rrcSaveHub(hubName, hubHash, hubEntry.dest_name || null).then(result => {
            // Delete the old hash-named entry
            api.rrcDeleteHub(foundTag).then(result2 => {
                state.rrcHubs = result2.hubs || result2;
                renderBookmarks();
            });
        });
    }
});

api.on("rrc:disconnected", (data) => {
    const hubHash = data.hub_hash || "";
    // Remove all RRC channels for this hub
    for(const [cid, ch] of Object.entries(state.channels)){
        if(ch.protocol === "rrc"){
            delete state.channels[cid];
        }
    }
    delete state.rrcConnections[hubHash];

    if(state.activeCid && !state.channels[state.activeCid]){
        const remaining = Object.keys(state.channels);
        state.activeCid = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    renderTabs();
    if(state.activeCid){
        renderMessages();
        renderMembers();
    } else {
        showSplash();
    }
});

api.on("rrc:joined", (data) => {
    const cid = `rrc:${data.room}`;
    state.channels[cid] = {
        name: data.room,
        hub: state.rrcActiveHubTag,
        hubDest: state.rrcActiveHubDest,
        key: null,
        protocol: "rrc",
        messages: [],
        members: (data.members || []).map(m => ({ nick: m, suffix: "", isSelf: false })),
    };
    addMessage(cid, `<span class="msg-system msg-join">Joined ${escapeHtml(data.room)}</span>`);
    state.activeCid = cid;
    renderTabs();
    showChat();
    renderMessages();
    renderMembers();
});

api.on("rrc:parted", (data) => {
    const cid = `rrc:${data.room}`;
    if(state.channels[cid]){
        addMessage(cid, `<span class="msg-system msg-leave">Left ${escapeHtml(data.room)}</span>`);
    }
    delete state.channels[cid];

    if(state.activeCid === cid){
        const remaining = Object.keys(state.channels);
        state.activeCid = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    renderTabs();
    if(state.activeCid){
        renderMessages();
        renderMembers();
    } else {
        showSplash();
    }
});

api.on("rrc:message", (data) => {
    const cid = `rrc:${data.room}`;
    const ts = formatTime(data.timestamp);
    const dn = displayNick(data.nick, data.suffix);
    addMessage(cid, `<span class="msg-time">${ts}</span><span class="msg-nick">&lt;${escapeHtml(dn)}&gt;</span> <span class="msg-body">${escapeHtml(data.body)}</span>`);
});

api.on("rrc:notice", (data) => {
    const cid = data.room ? `rrc:${data.room}` : state.activeCid;
    if(cid){
        addMessage(cid, `<span class="msg-system">${escapeHtml(data.body)}</span>`);
    }
});

api.on("rrc:error", (data) => {
    const cid = state.activeCid;
    if(cid){
        addMessage(cid, `<span class="msg-system" style="color:var(--danger)">${escapeHtml(data.body)}</span>`);
    }
});

api.on("rrc:hub_discovered", (data) => {
    const hash = data.hub_hash;
    const name = data.name || null;

    if(state.discoveredHubs.some(d => d.hash === hash)) return;
    state.discoveredHubs.push({ hash, name });
    renderBookmarks();
});

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

renderBookmarks();
$splashInput.focus();

// load saved theme
api.getSettings().then(s => {
    if(s.theme){
        document.documentElement.setAttribute("data-theme", s.theme);
        document.querySelectorAll(".theme-option").forEach(el => {
            el.classList.toggle("active", el.dataset.theme === s.theme);
        });
    }
});
