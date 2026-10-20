// MemeGuard na iPhone/iPad – ta sama logika oceny co wtyczka, bez trackera Twittera.
import { DEFAULTS, bestPair, tokenXLinks, scoreRisk, scoreMomentum, shouldAlert, riskLabel } from "./scoring.js";

const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/";
const DEX = "https://api.dexscreener.com";
const SOL = "So11111111111111111111111111111111111111112";
const B58 = "[1-9A-HJ-NP-Za-km-z]";
const CA_ONLY = new RegExp(`^${B58}{32,44}$`);
const CA_ANY = new RegExp(`${B58}{32,44}`);
const RUG_TTL = 3 * 60_000, DEX_TTL = 45_000, ALERT_COOLDOWN = 30 * 60_000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => v == null ? "–" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${Math.round(v)}`;
const age = (m) => m == null ? "–" : m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;

// ---------- pamięć (localStorage, bezpiecznie) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("mg:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mg:" + k, JSON.stringify(v)); } catch {} }
};
let cfg = { ...DEFAULTS, minMomentumForAlert: 30, ...store.get("cfg", {}) };
let results = store.get("results", {});      // ca -> wynik
let recent = store.get("recent", []);        // lista ca, najnowsze na początku
let watch = store.get("watch", []);          // lista ca
let alerted = store.get("alerted", {});
let twdb = store.get("twdb", { accounts: {}, tweets: {} });
const raw = {};                              // ca -> {rug, rugAt, pair, dexAt} (tylko w pamięci)
let feed = [];                               // ca z zakładki „Nowe”
let feedFilter = "all";
let selected = null;
let view = "recent";

function persist() {
  // przycinamy historię, żeby nie przepełnić pamięci
  recent = recent.slice(0, 60);
  const keep = new Set([...recent, ...watch, ...feed]);
  for (const ca of Object.keys(results)) if (!keep.has(ca)) delete results[ca];
  store.set("results", results); store.set("recent", recent); store.set("watch", watch);
  store.set("alerted", alerted); store.set("twdb", twdb);
}

// ---------- sieć: kolejka, żeby nie przekroczyć limitów API ----------
const q = []; let active = 0;
function enqueue(fn) { return new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); }); }
function pump() {
  while (active < 2 && q.length) {
    const { fn, res, rej } = q.shift(); active++;
    fn().then(res, rej).finally(() => { active--; setTimeout(pump, 350); });
  }
}
let lastOk = 0;
async function getJson(url) {
  return enqueue(async () => {
    let r;
    try { r = await fetch(url, { headers: { accept: "application/json" } }); }
    catch { setLive(false); throw new Error("brak połączenia"); }
    if (r.status === 429) throw new Error("limit zapytań, spróbuj za chwilę");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`błąd ${r.status}`);
    lastOk = Date.now(); setLive(true);
    return r.json();
  });
}
function setLive(ok) {
  $("liveDot").classList.toggle("live", ok);
  $("liveTxt").textContent = ok ? "na żywo" : "offline";
}

// ---------- recykling Twittera (pamięć 7 dni na tym urządzeniu) ----------
function recordTwitter(ca, links, createdAt) {
  const reuse = { projectAccountOtherCas: 0, tweetOtherCas: 0, tweetIsCopy: false, larpHandle: null, xLinks: [] };
  const famous = new Set(cfg.famousHandles || []);
  const t = createdAt || Date.now();
  for (const l of links) {
    if (l.tweetId) {
      reuse.xLinks.push(`@${l.handle}/status/${l.tweetId}`);
      const rec = (twdb.tweets[l.tweetId] ||= {}); rec[ca] ??= t;
      const others = Object.entries(rec).filter(([c]) => c !== ca);
      reuse.tweetOtherCas = Math.max(reuse.tweetOtherCas, others.length);
      if (others.some(([, ts]) => ts < rec[ca])) reuse.tweetIsCopy = true;
    } else if (l.handle) {
      reuse.xLinks.push(`@${l.handle}`);
      const rec = (twdb.accounts[l.handle] ||= {}); rec[ca] ??= t;
      reuse.projectAccountOtherCas = Math.max(reuse.projectAccountOtherCas, Object.keys(rec).filter((c) => c !== ca).length);
      if (famous.has(l.handle)) reuse.larpHandle = l.handle;
    }
  }
  return reuse;
}
function pruneTw() {
  const cut = Date.now() - 7 * 86_400_000;
  for (const kind of ["accounts", "tweets"]) for (const [k, rec] of Object.entries(twdb[kind])) {
    for (const [ca, ts] of Object.entries(rec)) if (ts < cut) delete rec[ca];
    if (!Object.keys(rec).length) delete twdb[kind][k];
  }
}

// ---------- analiza ----------
function compute(ca, { quick = false } = {}) {
  const t = raw[ca] || {};
  const links = tokenXLinks(t.pair, t.rug);
  const reuse = recordTwitter(ca, links, t.pair?.pairCreatedAt);
  const risk = scoreRisk(t.rug, t.pair, reuse, cfg);
  const mom = scoreMomentum(t.pair, [], cfg);
  const meta = t.rug?.tokenMeta || {};
  const r = {
    ca,
    symbol: t.pair?.baseToken?.symbol || meta.symbol || ca.slice(0, 4) + "…",
    name: t.pair?.baseToken?.name || meta.name || "",
    risk: risk.risk, hard: !!risk.hard, unknown: !!risk.unknown, riskReasons: risk.reasons,
    momentum: mom.momentum, momReasons: mom.reasons,
    mcap: t.pair?.marketCap ?? t.pair?.fdv ?? null, liq: t.pair?.liquidity?.usd ?? null,
    ageMin: t.pair?.pairCreatedAt ? Math.round((Date.now() - t.pair.pairCreatedAt) / 60000) : null,
    p5: t.pair?.priceChange?.m5 ?? null, p1: t.pair?.priceChange?.h1 ?? null,
    pairAddress: t.pair?.pairAddress || results[ca]?.pairAddress || null,
    dexUrl: t.pair?.url || null,
    xLinks: reuse.xLinks,
    quick: quick && !t.rug, // tylko DexScreener, bez RugCheck
    errors: t.errors || [],
    updatedAt: Date.now()
  };
  results[ca] = r;
  return { r, risk, mom };
}

async function analyze(ca, { force = false, skipRug = false } = {}) {
  const t = (raw[ca] ||= {});
  const now = Date.now();
  t.errors = [];
  const jobs = [];
  if (!skipRug && (force || !t.rugAt || now - t.rugAt > RUG_TTL)) {
    jobs.push(getJson(RUGCHECK + ca + "/report").then((d) => { if (d) { t.rug = d; t.rugAt = Date.now(); } }).catch((e) => t.errors.push("RugCheck: " + e.message)));
  }
  if (force || !t.dexAt || now - t.dexAt > DEX_TTL) {
    jobs.push(getJson(`${DEX}/tokens/v1/solana/${ca}`).then((d) => { t.pair = bestPair(Array.isArray(d) ? d : d?.pairs) || t.pair; t.dexAt = Date.now(); }).catch((e) => t.errors.push("DexScreener: " + e.message)));
  }
  await Promise.all(jobs);
  const out = compute(ca, { quick: skipRug });
  if (watch.includes(ca)) maybeAlert(out);
  persist();
  return out.r;
}

// zamiana wklejonego tekstu/linku na adres tokena
async function resolveInput(text) {
  const s = text.trim();
  if (!s) throw new Error("Wklej adres tokena (CA) albo link.");
  if (CA_ONLY.test(s)) return s;
  let url; try { url = new URL(s); } catch { url = null; }
  const m = s.match(CA_ANY);
  if (!m) throw new Error("Nie widzę tu adresu tokena Solany.");
  const addr = m[0];
  const host = url?.hostname || "";
  // Axiom i DexScreener używają w linkach adresu PARY, nie tokena
  if (/axiom\.trade|dexscreener\.com|photon|bullx/.test(host)) {
    const asToken = await getJson(`${DEX}/tokens/v1/solana/${addr}`).catch(() => null);
    if (Array.isArray(asToken) && asToken.length) return addr;
    const asPair = await getJson(`${DEX}/latest/dex/pairs/solana/${addr}`).catch(() => null);
    const p = asPair?.pairs?.[0] || asPair?.pair;
    if (p) return p.baseToken?.address === SOL ? p.quoteToken?.address : p.baseToken?.address;
  }
  return addr;
}

// ---------- alerty ----------
let audioCtx = null;
function beep() {
  if (!cfg.soundEnabled) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "triangle"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.45);
  } catch {}
}
document.addEventListener("pointerdown", () => { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch {} }, { once: true });

function maybeAlert({ r, risk, mom }) {
  if (!shouldAlert(risk, mom, cfg)) return;
  if (Date.now() - (alerted[r.ca] || 0) < ALERT_COOLDOWN) return;
  alerted[r.ca] = Date.now();
  const msg = `$${r.symbol}: ryzyko ${r.risk}, momentum ${r.momentum}. ${r.momReasons[0]?.text || ""}`;
  toast(msg, () => select(r.ca));
  beep();
  if ("Notification" in window && Notification.permission === "granted" && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification("MemeGuard – alert", {
      body: msg + "\nTo nie jest rekomendacja kupna.", icon: "icon-192.png", tag: "mg-" + r.ca, data: { url: axiomUrl(r) }
    })).catch(() => {});
  }
}
let toastTimer;
function toast(text, onTap) {
  const el = $("toast");
  el.textContent = text; el.classList.add("show");
  el.onclick = () => { el.classList.remove("show"); onTap?.(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 6000);
}

const axiomUrl = (r) => `https://axiom.trade/meme/${r.pairAddress || r.ca}`;

// ---------- widok ----------
const colorFor = (r) => r.hard ? "var(--bad)" : r.risk >= 60 ? "var(--bad)" : r.risk >= 35 ? "var(--warn)" : "var(--good)";
const rank = (r) => r.momentum - r.risk * 1.2 - (r.hard ? 100 : 0) - (r.unknown ? 30 : 0);

function rowHtml(r) {
  const c = colorFor(r);
  const ch = r.p5 != null ? ` · 5m ${r.p5 > 0 ? "+" : ""}${Math.round(r.p5)}%` : "";
  return `<button class="row${selected === r.ca ? " sel" : ""}" data-ca="${esc(r.ca)}">
    <span class="stripe" style="background:${c}"></span>
    <span class="r-main">
      <span class="r-sym"><span>$${esc(r.symbol)}</span>${r.hard ? '<span class="tag" style="color:var(--bad)">⛔ FLAGA</span>' : ""}${r.quick ? '<span class="tag">SZYBKA</span>' : ""}${watch.includes(r.ca) ? '<span class="tag">★</span>' : ""}</span>
      <span class="r-meta">MC ${money(r.mcap)} · Liq ${money(r.liq)} · ${age(r.ageMin)}${ch}</span>
    </span>
    <span class="r-scores">
      <span class="score" style="background:color-mix(in srgb,${c} 16%,transparent);color:${c}"><small>RYZYKO</small>${r.risk}</span>
      <span class="score" style="background:#8b74e81f;color:var(--accent-ink)"><small>MOM</small>${r.momentum}</span>
    </span></button>`;
}
function renderList(id, cas, emptyHtml, filter) {
  let rows = cas.map((ca) => results[ca]).filter(Boolean);
  if (filter) rows = rows.filter(filter);
  rows.sort((a, b) => rank(b) - rank(a));
  $(id).innerHTML = rows.length ? rows.map(rowHtml).join("") : `<div class="empty">${emptyHtml}</div>`;
}
function render() {
  renderList("recentList", recent, "<b>Nic jeszcze nie sprawdziłeś.</b><br>Wklej CA albo link z Axiom na górze. Możesz też zajrzeć do zakładki <b>Nowe</b>.");
  renderList("watchList", watch, "<b>Brak obserwowanych coinów.</b><br>Otwórz coina i stuknij ★ Obserwuj. Dostaniesz alert, gdy ryzyko spadnie poniżej progu, a momentum wzrośnie.");
  const f = feedFilter === "safe" ? (r) => !r.hard && !r.quick && r.risk < 35 : feedFilter === "mom" ? (r) => r.momentum >= 30 : null;
  renderList("feedList", feed, feed.length ? "Żaden coin nie spełnia filtra." : "Ładuję nowe tokeny…", f);
  const b = $("watchBadge"); b.hidden = !watch.length; b.textContent = watch.length;
  if (selected && results[selected]) renderDetail(results[selected]);
}

function renderDetail(r) {
  const c = colorFor(r), lab = riskLabel(r.risk);
  const watching = watch.includes(r.ca);
  const li = (x) => `<li class="${x.level === "danger" ? "d" : ""}"><span class="p">${x.pts > 0 ? "+" : ""}${x.pts}</span><span>${esc(x.text)}</span></li>`;
  $("detailBody").innerHTML = `
    <div class="d-head"><div><h3>$${esc(r.symbol)}</h3><div class="name">${esc(r.name)}</div></div>
      <button class="btn x" data-act="close" aria-label="Zamknij">✕</button></div>
    <div class="gauges">
      <div class="gauge"><div class="lbl">RYZYKO RUGPULLA</div><div class="val" style="color:${c}">${r.risk}<small>/100</small></div>
        <div class="word" style="color:${c}">${r.hard ? "⛔ CZERWONA FLAGA" : r.unknown ? "BRAK DANYCH" : lab.text}</div>
        <div class="meter"><i style="width:${r.risk}%;background:${c}"></i></div></div>
      <div class="gauge"><div class="lbl">MOMENTUM</div><div class="val" style="color:var(--accent-ink)">${r.momentum}<small>/100</small></div>
        <div class="word" style="color:var(--muted)">transakcje i wolumen</div>
        <div class="meter"><i style="width:${r.momentum}%;background:var(--accent)"></i></div></div>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">MARKET CAP</div><div class="v">${money(r.mcap)}</div></div>
      <div class="fact"><div class="k">PŁYNNOŚĆ</div><div class="v">${money(r.liq)}</div></div>
      <div class="fact"><div class="k">WIEK PARY</div><div class="v">${age(r.ageMin)}</div></div>
    </div>
    <div class="reasons">
      <h4>DLACZEGO TAKIE RYZYKO</h4><ul>${r.riskReasons.map(li).join("") || "<li><span class='p'>0</span><span>Brak czerwonych flag</span></li>"}</ul>
      ${r.quick ? `<p class="disclaimer">To szybka ocena bez RugCheck. Stuknij Odśwież, żeby sprawdzić authority i holderów.</p>` : ""}
      <h4>MOMENTUM</h4><ul>${r.momReasons.map(li).join("") || "<li><span class='p'>0</span><span>Brak sygnałów</span></li>"}</ul>
      ${r.xLinks.length ? `<h4>X TOKENA</h4><ul><li><span class="p"></span><span>${esc(r.xLinks.join(", "))}</span></li></ul>` : ""}
      ${r.errors.length ? `<h4>PROBLEMY Z DANYMI</h4><ul>${r.errors.map((e) => `<li><span class="p">!</span><span>${esc(e)}</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="ca">${esc(r.ca)}</div>
    <div class="acts">
      <a class="btn primary wide" href="${esc(axiomUrl(r))}" target="_blank" rel="noopener">Otwórz na Axiom</a>
      <button class="btn" data-act="watch">${watching ? "★ Obserwujesz" : "☆ Obserwuj"}</button>
      <button class="btn" data-act="copy">Kopiuj CA</button>
      <a class="btn" href="https://rugcheck.xyz/tokens/${esc(r.ca)}" target="_blank" rel="noopener">RugCheck</a>
      <button class="btn" data-act="refresh">Odśwież</button>
    </div>
    <p class="disclaimer">Zaktualizowano ${new Date(r.updatedAt).toLocaleTimeString("pl-PL")}. Ocena to filtr ryzyka, a nie rekomendacja. Większość meme coinów traci wartość.</p>`;
}

const wide = () => matchMedia("(min-width:820px)").matches;
function openSheet(open) {
  $("detail").classList.toggle("open", open);
  $("scrim").classList.toggle("open", open && !wide());
}
function select(ca) {
  selected = ca;
  const r = results[ca];
  if (r) renderDetail(r);
  openSheet(true);
  render();
  // dociągamy pełne dane (RugCheck), jeśli to była szybka ocena albo stare dane
  if (!r || r.quick || Date.now() - r.updatedAt > DEX_TTL) analyze(ca).then(render);
}

// ---------- „Nowe” z DexScreenera ----------
let feedLoading = false;
async function loadFeed() {
  if (feedLoading) return; feedLoading = true;
  $("feedRefresh").textContent = "Ładuję…";
  try {
    const [profiles, boosts] = await Promise.all([
      getJson(`${DEX}/token-profiles/latest/v1`).catch(() => []),
      getJson(`${DEX}/token-boosts/latest/v1`).catch(() => [])
    ]);
    const cas = [...new Set([...(profiles || []), ...(boosts || [])].filter((x) => x?.chainId === "solana").map((x) => x.tokenAddress))].slice(0, 30);
    if (!cas.length) throw new Error("DexScreener nie zwrócił nowych tokenów.");
    const pairs = await getJson(`${DEX}/tokens/v1/solana/${cas.join(",")}`);
    const byToken = {};
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const ca = p.baseToken?.address; if (!ca) continue;
      (byToken[ca] ||= []).push(p);
    }
    for (const ca of cas) {
      const t = (raw[ca] ||= {});
      if (byToken[ca]) { t.pair = bestPair(byToken[ca]); t.dexAt = Date.now(); }
      compute(ca, { quick: true });
    }
    feed = cas.filter((ca) => results[ca]);
    render();
    // RugCheck po kolei dla najlepiej wyglądających (limit API)
    const order = [...feed].sort((a, b) => rank(results[b]) - rank(results[a])).slice(0, 12);
    for (const ca of order) { if (view !== "feed") break; await analyze(ca).catch(() => {}); render(); }
  } catch (e) {
    $("feedList").innerHTML = `<div class="empty">Nie udało się pobrać nowych tokenów: ${esc(e.message)}</div>`;
  } finally { feedLoading = false; $("feedRefresh").textContent = "Odśwież"; persist(); }
}

// ---------- zdarzenia ----------
async function check(text) {
  $("err").hidden = true;
  $("goBtn").disabled = true; $("goBtn").textContent = "…";
  try {
    const ca = await resolveInput(text);
    recent = [ca, ...recent.filter((x) => x !== ca)];
    $("q").value = "";
    await analyze(ca, { force: true });
    switchView("recent");
    select(ca);
  } catch (e) {
    $("err").textContent = e.message; $("err").hidden = false;
  } finally { $("goBtn").disabled = false; $("goBtn").textContent = "Sprawdź"; }
}
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); check($("q").value); });
$("pasteBtn").addEventListener("click", async () => {
  try { const t = await navigator.clipboard.readText(); if (t) { $("q").value = t.trim(); check(t); } }
  catch { $("q").focus(); $("err").textContent = "Przytrzymaj pole i wybierz „Wklej”."; $("err").hidden = false; }
});

document.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) { select(row.dataset.ca); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act || !selected) return;
  const r = results[selected];
  if (act === "close") openSheet(false);
  if (act === "watch") {
    watch = watch.includes(selected) ? watch.filter((x) => x !== selected) : [selected, ...watch];
    persist(); render();
  }
  if (act === "copy") {
    navigator.clipboard?.writeText(selected).then(() => toast("Skopiowano CA")).catch(() => toast("Nie udało się skopiować – zaznacz adres ręcznie"));
  }
  if (act === "refresh") { e.target.textContent = "…"; analyze(selected, { force: true }).then(render); }
});
$("scrim").addEventListener("click", () => openSheet(false));

function switchView(v) {
  view = v;
  document.querySelectorAll("[data-view]").forEach((s) => (s.hidden = s.dataset.view !== v));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === v));
  if (v === "feed" && !feed.length) loadFeed();
  if (v === "watch") refreshWatch();
}
$("tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) switchView(t.dataset.tab); });
$("feedRefresh").addEventListener("click", loadFeed);
$("feedFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  feedFilter = b.dataset.f;
  document.querySelectorAll("#feedFilter .chipbtn").forEach((x) => x.classList.toggle("on", x === b));
  render();
});

// ---------- ustawienia ----------
function loadCfgUi() {
  $("maxRisk").value = cfg.maxRiskForAlert; $("minMom").value = cfg.minMomentumForAlert;
  $("alertsOn").checked = cfg.alertsEnabled; $("soundOn").checked = cfg.soundEnabled;
  $("famous").value = (cfg.famousHandles || []).join(", ");
  $("riskV").textContent = cfg.maxRiskForAlert; $("momV").textContent = cfg.minMomentumForAlert;
  updateNotifUi();
}
["maxRisk", "minMom"].forEach((id) => $(id).addEventListener("input", () => { $("riskV").textContent = $("maxRisk").value; $("momV").textContent = $("minMom").value; }));
$("saveCfg").addEventListener("click", () => {
  cfg = { ...cfg, maxRiskForAlert: +$("maxRisk").value, minMomentumForAlert: +$("minMom").value,
    alertsEnabled: $("alertsOn").checked, soundEnabled: $("soundOn").checked,
    famousHandles: $("famous").value.split(/[\s,]+/).map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean) };
  store.set("cfg", cfg);
  $("cfgOk").textContent = "Zapisano ✓"; setTimeout(() => ($("cfgOk").textContent = ""), 2000);
});
$("clearAll").addEventListener("click", (e) => {
  if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Na pewno? Stuknij jeszcze raz"; return; }
  results = {}; recent = []; watch = []; alerted = {}; twdb = { accounts: {}, tweets: {} }; feed = []; selected = null;
  persist(); render(); openSheet(false);
  e.target.dataset.sure = ""; e.target.textContent = "Wyczyść historię i listy";
});
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function updateNotifUi() {
  const note = $("notifNote"), btn = $("notifBtn");
  if (!("Notification" in window)) {
    btn.disabled = true;
    note.textContent = standalone() ? "To urządzenie nie obsługuje powiadomień (potrzebny iOS 16.4 lub nowszy)." : "Powiadomienia działają dopiero po dodaniu aplikacji do ekranu głównego (iOS 16.4+). Alerty w aplikacji i dźwięk działają zawsze.";
    return;
  }
  btn.disabled = Notification.permission !== "default";
  note.textContent = Notification.permission === "granted" ? "Powiadomienia włączone. Działają, gdy aplikacja jest otwarta lub niedawno używana." :
    Notification.permission === "denied" ? "Powiadomienia zablokowane. Włącz je w Ustawieniach iOS → Powiadomienia → MemeGuard." : "";
}
$("notifBtn").addEventListener("click", async () => { try { await Notification.requestPermission(); } catch {} updateNotifUi(); });

// ---------- odświeżanie obserwowanych ----------
async function refreshWatch() {
  for (const ca of watch) { await analyze(ca).catch(() => {}); }
  render();
}
setInterval(() => { if (document.visibilityState === "visible" && watch.length) refreshWatch(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && watch.length) refreshWatch(); });

// ---------- start ----------
function measureHeader() { document.documentElement.style.setProperty("--hh", $("top").offsetHeight + "px"); }
addEventListener("resize", measureHeader); measureHeader();
pruneTw();
loadCfgUi();
render();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
// ?ca=... w linku (np. ze Skrótów iOS) od razu sprawdza token
const qp = new URLSearchParams(location.search).get("ca");
if (qp) check(qp);
else if (wide() && recent[0]) select(recent[0]);
