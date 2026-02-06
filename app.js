/* Kontrola inwestycji (MVP) – Stooq (frontend-only)
   Stooq nie daje CORS -> potrzebujesz proxy.
   Ten plik używa Twojego Cloudflare Worker jako proxy (najstabilniej).

   Fixy:
   - FX (usdpln/eurpln) pobieramy tylko gdy faktycznie potrzebne
   - twardy check: jeśli nie ma cen dla symboli -> błąd (UI nie kłamie "odświeżono")
   - defensywa dla localStorage i formatowania liczb
*/

const LS_KEY = "inv_mvp_holdings_v3_stooq";
const LS_FX  = "inv_mvp_fx_v3_stooq";

// Twoje proxy (Cloudflare Worker):
const PROXY_WORKER = "https://crimson-tooth-900e.michalbursztyn103.workers.dev/?url=";

// cache: żeby nie katować proxy (ale nie blokuj, jeśli nie masz cen)
const MIN_REFRESH_HOURS = 1;

// DOM
const elName = document.getElementById("name");
const elSymbol = document.getElementById("symbol");
const elCcy = document.getElementById("ccy");
const elQty = document.getElementById("qty");

const elSumPln = document.getElementById("sumPln");
const elUsdPln = document.getElementById("usdpln");
const elEurPln = document.getElementById("eurpln");
const elLastRefresh = document.getElementById("lastRefresh");
const elTbody = document.getElementById("tbody");
const elMsg = document.getElementById("msg");

const btnAdd = document.getElementById("addBtn");
const btnRefresh = document.getElementById("refreshBtn");
const btnReset = document.getElementById("resetBtn");

// helpers
const nowIso = () => new Date().toISOString();

const n0 = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
};

const fmtPLN   = (n) => n0(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";
const fmtNum   = (n, d=4) => n0(n).toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: d });
const fmtPrice = (n) => n0(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

function uid(){ return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16); }

function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function setMsg(text, kind="err"){
  elMsg.textContent = text || "";
  elMsg.className = "hint " + (kind === "ok" ? "ok" : "err");
}

function hoursSince(iso){
  if(!iso) return Infinity;
  const t = new Date(iso).getTime();
  if(!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000*60*60);
}

function loadHoldings(){
  try{
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveHoldings(list){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch(e){
    console.warn("saveHoldings failed:", e);
  }
}

function loadFx(){
  try{
    const v = JSON.parse(localStorage.getItem(LS_FX) || "null");
    return (v && typeof v === "object") ? v : null;
  } catch {
    return null;
  }
}

function saveFx(obj){
  try{
    localStorage.setItem(LS_FX, JSON.stringify(obj && typeof obj === "object" ? obj : null));
  } catch(e){
    console.warn("saveFx failed:", e);
  }
}

function safeFloat(x){
  // Stooq zwraca kropkę, ale defensywnie też wspieramy przecinek
  const n = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function parseCsv(csvText){
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if(lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim());
  const rows = [];

  for(let i=1; i<lines.length; i++){
    const parts = lines[i].split(",").map(x => NoticeTrim(x));
    const obj = {};
    for(let j=0; j<headers.length; j++){
      obj[headers[j]] = parts[j] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function NoticeTrim(x){
  return (x ?? "").toString().trim();
}

// ---- STOOQ FETCH (via your Worker) ----
function buildStooqUrl(symbols){
  const s = symbols
    .map(x => (x || "").trim().toLowerCase())
    .filter(Boolean)
    .join(",");

  if(!s) return null;

  // f=sd2t2ohlcv -> Symbol,Date,Time,Open,High,Low,Close,Volume
  return `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
}

async function fetchViaWorker(rawUrl){
  const u = PROXY_WORKER + encodeURIComponent(rawUrl);
  const r = await fetch(u, { cache: "no-store" });
  if(!r.ok) throw new Error("Proxy worker HTTP " + r.status);
  return await r.text();
}

async function fetchStooqQuotes(symbols){
  const rawUrl = buildStooqUrl(symbols);
  if(!rawUrl) return [];

  const csvText = await fetchViaWorker(rawUrl);

  // Jeśli proxy zwróci HTML (blokada/limit), nie udawaj CSV
  if(/<html|<!doctype/i.test(csvText)){
    throw new Error("Proxy zwróciło HTML zamiast CSV (blokada/limit).");
  }

  return parseCsv(csvText);
}

// ---- RENDER ----
function render(){
  let holdings = loadHoldings();
  if(!Array.isArray(holdings)) holdings = [];

  const fx = loadFx() || {};

  elUsdPln.textContent = fx.usdpln ? fmtPrice(fx.usdpln) : "-";
  elEurPln.textContent = fx.eurpln ? fmtPrice(fx.eurpln) : "-";
  elLastRefresh.textContent = fx.ts ? new Date(fx.ts).toLocaleString("pl-PL") : "-";

  elTbody.innerHTML = "";

  let sumPln = 0;

  for(const h of holdings){
    const price = Number.isFinite(h.lastPrice) ? h.lastPrice : NaN;

    let fxRate = 1;
    if(h.ccy === "USD") fxRate = fx.usdpln || NaN;
    if(h.ccy === "EUR") fxRate = fx.eurpln || NaN;

    const qty = n0(h.qty);
    const valuePln = (Number.isFinite(price) && Number.isFinite(fxRate)) ? (qty * price * fxRate) : 0;
    sumPln += valuePln;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(h.name || "")}</td>
      <td><span class="pill">${escapeHtml(h.symbol || "")}</span></td>
      <td>${escapeHtml(h.ccy || "PLN")}</td>
      <td class="num">${fmtNum(qty, 6)}</td>
      <td class="num">${Number.isFinite(price) ? fmtPrice(price) : "<span class='err'>-</span>"}</td>
      <td class="num">${fmtPLN(valuePln)}</td>
      <td class="num"><button class="trash" data-del="${h.id}">Usuń</button></td>
    `;
    elTbody.appendChild(tr);
  }

  elSumPln.textContent = fmtPLN(sumPln);

  elTbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-del");
      const list = loadHoldings().filter(x => x.id !== id);
      saveHoldings(list);
      render();
    });
  });
}

// ---- ACTIONS ----
btnAdd.addEventListener("click", ()=>{
  setMsg("");

  const name = elName.value.trim();
  const symbol = elSymbol.value.trim().toLowerCase();
  const ccy = elCcy.value;
  const qty = parseFloat(elQty.value);

  if(!name) return setMsg("Podaj nazwę.");
  if(!symbol) return setMsg("Podaj symbol Stooq.");
  if(!Number.isFinite(qty) || qty <= 0) return setMsg("Ilość ma być > 0.");

  const list = loadHoldings();
  list.push({
    id: uid(),
    name,
    symbol,
    ccy,
    qty,
    lastPrice: NaN,
    lastPriceTs: null
  });
  saveHoldings(list);

  elName.value = "";
  elSymbol.value = "";
  elQty.value = "";

  render();
  setMsg("Dodano. Teraz kliknij Odśwież.", "ok");
});

btnReset.addEventListener("click", ()=>{
  if(!confirm("Na pewno wyczyścić wszystko?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_FX);
  setMsg("Wyczyszczone.", "ok");
  render();
});

function chunk(arr, size){
  const out = [];
  for(let i=0; i<arr.length; i+=size){
    out.push(arr.slice(i, i+size));
  }
  return out;
}


btnRefresh.addEventListener("click", async ()=>{
  setMsg("");

  const btn = btnRefresh;
  btn.disabled = true;
  btn.textContent = "Odświeżam…";

  try{
    let holdings = loadHoldings();
    if(!Array.isArray(holdings)) holdings = [];

    if(holdings.length === 0){
      setMsg("Nie masz żadnych pozycji.", "err");
      return;
    }

    const needsUSD = holdings.some(h => h.ccy === "USD");
    const needsEUR = holdings.some(h => h.ccy === "EUR");

    const fxPrev = loadFx();

    // Cache blokuje tylko jeśli:
// - niedawno odświeżane
// - i NIE masz braków w cenach (czyli nie blokujemy nowo dodanych pozycji)
const haveMissingPrices = holdings.some(h => !Number.isFinite(h.lastPrice));
if(fxPrev && !haveMissingPrices && hoursSince(fxPrev.ts) < MIN_REFRESH_HOURS){
  setMsg(`Cache: ostatnie odświeżenie było niedawno (min ${MIN_REFRESH_HOURS}h).`, "ok");
  render();
  return;
}


    const symbols = [...new Set([
      ...holdings.map(h => h.symbol),
      ...(needsUSD ? ["usdpln"] : []),
      ...(needsEUR ? ["eurpln"] : []),
    ])];

    const rows = [];
const batches = chunk(symbols, 3); // 3 to bezpieczna liczba dla Stooq

for(const batch of batches){
  const part = await fetchStooqQuotes(batch);
  rows.push(...part);
  await new Promise(r => setTimeout(r, 200));
}



    const priceBySymbol = new Map();
    for(const r of rows){
      const sym = NoticeTrim(r.Symbol || r.symbol).toLowerCase();
      const close = safeFloat(r.Close ?? r.close);
      if(sym) priceBySymbol.set(sym, close);
    }

    // Twardy check: jeśli nie mamy ceny dla jakiegoś symbolu z portfela, nie udajemy sukcesu.
    const missing = holdings
      .map(h => (h.symbol || "").toLowerCase())
      .filter(sym => !Number.isFinite(priceBySymbol.get(sym)));

    if(missing.length){
      throw new Error("Brak cen dla: " + missing.join(", ") + " (symbol Stooq albo problem po stronie Stooq/proxy).");
    }

    const usdpln = needsUSD ? priceBySymbol.get("usdpln") : undefined;
    const eurpln = needsEUR ? priceBySymbol.get("eurpln") : undefined;

    if(needsUSD && !Number.isFinite(usdpln)){
      throw new Error("Nie udało się pobrać USD/PLN.");
    }
    if(needsEUR && !Number.isFinite(eurpln)){
      throw new Error("Nie udało się pobrać EUR/PLN.");
    }

    for(const h of holdings){
      const p = priceBySymbol.get((h.symbol || "").toLowerCase());
      h.lastPrice = p;
      h.lastPriceTs = nowIso();
    }

    saveHoldings(holdings);

    const prev = fxPrev || {};
    saveFx({
      usdpln: needsUSD ? usdpln : prev.usdpln,
      eurpln: needsEUR ? eurpln : prev.eurpln,
      ts: nowIso()
    });

    setMsg("Odświeżono.", "ok");
    render();

  } catch(e){
    setMsg(String(e?.message || e), "err");
    render();
  } finally{
    btn.disabled = false;
    btn.textContent = "Odśwież (Stooq)";
  }
});

// init
render();
