// MemeGuard – logika oceny. Czyste funkcje (bez chrome.*), żeby dało się je testować.
//
// RYZYKO (0–100, im wyżej tym gorzej) – sygnały, które według badań i narzędzi
// (RugCheck, Solidus Labs, prace o rugpullach na Solanie) najlepiej wyłapują rugi:
//   1. Aktywny mint/freeze authority – dev może dodrukować tokeny albo zamrozić portfele.
//   2. Koncentracja podaży – top 10 / pojedynczy portfel / insiderzy / bundle.
//   3. Portfel deva – ile jeszcze trzyma.
//   4. Recykling Twittera – konto X projektu lub ten sam tweet użyty już przy innych coinach.
//   5. LARP – token podpina cudze (znane) konto X jako „swoje”.
//   6. Bardzo niska płynność.
//
// MOMENTUM (0–100) – nie jest prognozą ceny, tylko miarą „szumu” i presji kupujących:
//   wzmianki z trackera Twittera, KOL-e z Twojej listy, przewaga kupujących, wzrost wolumenu.

export const DEFAULTS = {
  maxRiskForAlert: 35,
  minMomentumForAlert: 50,
  alertsEnabled: true,
  soundEnabled: true,
  kolHandles: [],          // konta, którym ufasz (małe litery, bez @)
  famousHandles: [         // konta, pod które scamerzy często się podszywają (LARP)
    "elonmusk", "realdonaldtrump", "cz_binance", "vitalikbuterin", "aeyakovenko",
    "rajgokal", "solana", "pumpdotfun", "axiomexchange", "kanyewest", "drake"
  ],
  mentionWindowMin: 30
};

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const pick = (o, ...keys) => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** Wyciąga handle i id tweeta z linku x.com / twitter.com */
export function parseXUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/status(?:es)?\/(\d+))?/i);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (["i", "home", "search", "intent", "share", "hashtag"].includes(handle)) {
    // np. x.com/i/communities/123 – społeczność, nie konto
    const comm = url.match(/\/i\/communities\/(\d+)/);
    return comm ? { handle: null, tweetId: null, communityId: comm[1] } : null;
  }
  return { handle, tweetId: m[2] || null, communityId: null };
}

/** Najlepsza para DexScreener (największa płynność) */
export function bestPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  return [...pairs].sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
}

/** Zbiera linki X tokena (z DexScreenera i metadanych RugCheck) */
export function tokenXLinks(pair, rug) {
  const urls = new Set();
  for (const s of pair?.info?.socials || []) {
    if (/twitter|x/i.test(s.type || "") || /(?:x|twitter)\.com/i.test(s.url || "")) urls.add(s.url);
  }
  const meta = pick(rug, "tokenMeta", "token_meta") || {};
  const fileMeta = pick(rug, "fileMeta", "file_meta") || {};
  for (const u of [meta.twitter, fileMeta.twitter, pick(fileMeta, "extensions")?.twitter]) {
    if (u) urls.add(u);
  }
  return [...urls].map(parseXUrl).filter(Boolean);
}

/**
 * Ocena ryzyka.
 * @param {object} rug   raport RugCheck (/v1/tokens/{mint}/report) albo null
 * @param {object} pair  najlepsza para z DexScreenera albo null
 * @param {object} reuse { projectAccountOtherCas:number, tweetOtherCas:number, tweetIsCopy:boolean }
 * @param {object} cfg   ustawienia
 */
export function scoreRisk(rug, pair, reuse = {}, cfg = DEFAULTS) {
  const reasons = [];
  let risk = 0;
  let hard = false; // „deal-breaker” – od razu czerwone
  const add = (pts, text, level = "warn") => { risk += pts; reasons.push({ pts, text, level }); };

  if (!rug && !pair) {
    return { risk: 60, hard: false, reasons: [{ pts: 60, text: "Brak danych z RugCheck i DexScreener (token za świeży albo API nie odpowiada)", level: "warn" }], unknown: true };
  }

  if (rug) {
    if (pick(rug, "rugged") === true) {
      return { risk: 100, hard: true, reasons: [{ pts: 100, text: "RugCheck oznacza token jako już zrugowany", level: "danger" }] };
    }
    const token = pick(rug, "token") || {};
    const mintAuth = pick(rug, "mintAuthority", "mint_authority") ?? pick(token, "mintAuthority", "mint_authority");
    const freezeAuth = pick(rug, "freezeAuthority", "freeze_authority") ?? pick(token, "freezeAuthority", "freeze_authority");
    if (mintAuth) { add(35, "Mint authority aktywny – dev może dodrukować tokeny", "danger"); hard = true; }
    if (freezeAuth) { add(35, "Freeze authority aktywny – dev może zamrozić Twoje tokeny", "danger"); hard = true; }

    // Koncentracja holderów (pomijamy konta pul płynności / znane konta AMM)
    const known = pick(rug, "knownAccounts", "known_accounts") || {};
    // Adresy pul i bonding curve (np. pump.fun) – nie liczymy ich jako „wielorybów”
    const poolAddrs = new Set();
    const collect = (o, depth = 0) => {
      if (!o || depth > 2) return;
      for (const v of Object.values(o)) {
        if (typeof v === "string" && v.length >= 32) poolAddrs.add(v);
        else if (v && typeof v === "object") collect(v, depth + 1);
      }
    };
    for (const mk of pick(rug, "markets") || []) collect(mk);
    if (pair?.pairAddress) poolAddrs.add(pair.pairAddress);
    const mintAddr = pick(rug, "mint");
    if (mintAddr) poolAddrs.delete(mintAddr);
    const isPool = (owner, addr) => {
      if (poolAddrs.has(owner) || poolAddrs.has(addr)) return true;
      const k = known[owner] || known[addr];
      return k && /amm|pool|lp|bonding|curve|pump|raydium|meteora/i.test(`${k.type || ""} ${k.name || ""}`);
    };
    const holders = (pick(rug, "topHolders", "top_holders") || [])
      .filter((h) => !isPool(h.owner, h.address))
      .map((h) => ({ pct: num(h.pct) ?? 0, insider: !!h.insider }));
    if (holders.length) {
      const top10 = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
      const maxOne = Math.max(...holders.map((h) => h.pct));
      if (top10 > 50) add(25, `Top 10 portfeli trzyma ${top10.toFixed(0)}% podaży`, "danger");
      else if (top10 > 35) add(15, `Top 10 portfeli trzyma ${top10.toFixed(0)}% podaży`);
      if (maxOne > 15) add(15, `Jeden portfel trzyma ${maxOne.toFixed(0)}% podaży`, "danger");
      else if (maxOne > 8) add(6, `Jeden portfel trzyma ${maxOne.toFixed(0)}% podaży`);
      const insiderPct = holders.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0);
      if (insiderPct > 10) add(15, `Insiderzy (powiązane portfele) trzymają ${insiderPct.toFixed(0)}%`, "danger");
    }

    const insiders = num(pick(rug, "graphInsidersDetected", "graph_insiders_detected")) || 0;
    if (insiders >= 10) add(20, `Wykryto ${insiders} powiązanych portfeli insiderów (sieć/bundle)`, "danger");
    else if (insiders >= 3) add(10, `Wykryto ${insiders} powiązane portfele insiderów`);

    // Portfel deva
    const supply = num(pick(token, "supply"));
    const decimals = num(pick(token, "decimals")) ?? 6;
    const creatorBal = num(pick(rug, "creatorBalance", "creator_balance"));
    if (supply && creatorBal !== null && supply > 0) {
      // creatorBalance bywa w jednostkach surowych – normalizujemy
      const devPct = (creatorBal / supply) * 100 > 100 ? (creatorBal / 10 ** decimals / supply) * 100 : (creatorBal / supply) * 100;
      if (devPct > 10) add(15, `Dev wciąż trzyma ${devPct.toFixed(1)}% podaży`, "danger");
      else if (devPct > 4) add(6, `Dev trzyma ${devPct.toFixed(1)}% podaży`);
    }

    // Ryzyka zgłoszone przez RugCheck (bez dublowania tego, co liczymy wyżej)
    const skip = /mint authority|freeze authority|top 10|single holder|large amount|insider|creator/i;
    let extra = 0;
    for (const r of pick(rug, "risks") || []) {
      if (!r?.name || skip.test(r.name)) continue;
      const pts = r.level === "danger" ? 10 : r.level === "warn" ? 3 : 0;
      if (!pts || extra >= 25) continue;
      extra += pts;
      add(pts, `RugCheck: ${r.name}${r.value ? ` (${r.value})` : ""}`, r.level === "danger" ? "danger" : "warn");
    }
  } else {
    add(15, "Brak raportu RugCheck – nie sprawdzono authority ani holderów");
  }

  // Płynność
  const liq = num(pair?.liquidity?.usd);
  if (liq !== null && liq < 3000) add(12, `Bardzo niska płynność ($${Math.round(liq)})`);

  // Recykling Twittera / LARP
  if (reuse.projectAccountOtherCas > 0) {
    add(Math.min(40, 20 + reuse.projectAccountOtherCas * 5),
      `Konto X projektu było już podpięte pod ${reuse.projectAccountOtherCas} inny(ch) coin(ów) – recykling`, "danger");
  }
  if (reuse.tweetIsCopy && reuse.tweetOtherCas > 0) {
    add(20, `Ten sam tweet użyto już przy ${reuse.tweetOtherCas} wcześniejszym coinie – to kopia, nie oryginał`, "danger");
  }
  if (reuse.larpHandle) {
    add(25, `Token podpina cudze konto @${reuse.larpHandle} jako swoje – możliwy LARP`, "danger");
  }

  risk = Math.max(0, Math.min(100, Math.round(risk)));
  if (hard) risk = Math.max(risk, 80);
  return { risk, hard, reasons };
}

/**
 * Momentum.
 * @param {object} pair     para DexScreener albo null
 * @param {Array}  mentions [{handle, ts}] wzmianki z trackera w oknie czasowym
 */
export function scoreMomentum(pair, mentions = [], cfg = DEFAULTS, now = Date.now()) {
  const reasons = [];
  let m = 0;
  const add = (pts, text) => { m += pts; reasons.push({ pts, text }); };

  const windowMs = (cfg.mentionWindowMin || 30) * 60_000;
  const recent = mentions.filter((x) => now - x.ts <= windowMs);
  const handles = [...new Set(recent.map((x) => x.handle).filter(Boolean))];
  if (handles.length) add(Math.min(40, handles.length * 12), `${handles.length} kont z trackera wspomniało CA w ${cfg.mentionWindowMin} min`);
  const kols = handles.filter((h) => (cfg.kolHandles || []).includes(h));
  if (kols.length) add(Math.min(30, kols.length * 15), `KOL z Twojej listy: @${kols.join(", @")}`);

  if (pair) {
    const t5 = pair.txns?.m5 || {}, t1 = pair.txns?.h1 || {};
    const b5 = t5.buys || 0, s5 = t5.sells || 0;
    if (b5 + s5 >= 10) {
      const ratio = b5 / Math.max(1, s5);
      if (ratio >= 2) add(15, `Kupujący przeważają w 5 min (${b5} kupna / ${s5} sprzedaży)`);
      else if (ratio >= 1.3) add(8, `Lekka przewaga kupujących w 5 min (${b5}/${s5})`);
      else if (ratio < 0.7) add(-10, `Sprzedający przeważają w 5 min (${b5}/${s5})`);
    }
    const v1 = num(pair.volume?.h1), v6 = num(pair.volume?.h6);
    if (v1 && v6 && v6 > 0) {
      const accel = v1 / (v6 / 6);
      if (accel >= 3) add(15, `Wolumen przyspiesza (ostatnia godzina ${accel.toFixed(1)}× średniej)`);
      else if (accel >= 1.5) add(7, `Wolumen rośnie (${accel.toFixed(1)}× średniej)`);
    }
    const p5 = num(pair.priceChange?.m5), p1 = num(pair.priceChange?.h1);
    if (p5 !== null && p5 > 5) add(5, `Cena +${p5.toFixed(0)}% w 5 min`);
    if (p1 !== null && p1 < -50) add(-15, `Cena ${p1.toFixed(0)}% w godzinę – możliwy dump`);
    if ((t1.buys || 0) + (t1.sells || 0) >= 300) add(5, "Duży ruch: 300+ transakcji w godzinę");
  }

  m = Math.max(0, Math.min(100, Math.round(m)));
  return { momentum: m, reasons, mentionHandles: handles };
}

export function shouldAlert(risk, momentum, cfg = DEFAULTS) {
  return cfg.alertsEnabled && !risk.hard && !risk.unknown &&
    risk.risk <= cfg.maxRiskForAlert && momentum.momentum >= cfg.minMomentumForAlert;
}

export function riskLabel(r) {
  if (r >= 60) return { text: "WYSOKIE", color: "#e5484d" };
  if (r >= 35) return { text: "ŚREDNIE", color: "#f5a524" };
  return { text: "NISKIE", color: "#30a46c" };
}
