/* Kontrola inwestycji (MVP) – Stooq (frontend-only)
   Stooq nie daje CORS => "Failed to fetch".
   Rozwiązanie: CORS proxy (AllOrigins -> corsproxy.io -> r.jina.ai)
   Fixy:
   - FX (usdpln/eurpln) pobieramy tylko gdy faktycznie potrzebne
   - wykrywamy HTML zamiast CSV (proxy limit/blokada)
   - defensywa dla localStorage i formatowania liczb
*/

const LS_KEY = "inv_mvp_holdings_v3_stooq";
const LS_FX  = "inv_mvp_fx_v3_stooq";

// cache, żebyś nie klikał 30 razy "bo nie ufam"
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

// Number(null) => 0 (ok), Number("") => 0 (ok), Number("1,23") => NaN (dlatego safeFloat niżej)
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
    const parts = lines[i].split(",").map(x => x.trim());
    const obj = {};
    for(let j=0; j<headers.length; j++){
      obj[headers[j]] = parts[j] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

// ---- STOOQ FETCH (CORS proxy) ----
function buildStooqUrl(symbols){
  const s = symbols
    .map(x => (x || "").trim().toLowerCase())
    .filter(Boolean)
    .join(",");

  if(!s) return null;

  // f=sd2t2ohlcv -> Symbol,Date,Time,Open,High,Low,Close,Volume
  return `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
}

async function fetchViaProxy(rawUrl){
  // Proxy #1: AllOrigins GET (ma CORS), zwraca JSON { contents: "..." }
  const u1 = `https://api.allorigins.win/get?url=${encodeURIComponent(rawUrl)}`;
  try{
    const r1 = await fetch(u1, { cache: "no-store" });
    if(!r1.ok) throw new Error("AllOrigins GET HTTP " + r1.status);
    const j = await r1.json();
    if(!j || typeof j.contents !== "string") throw new Error("AllOrigins GET: brak contents");
    return j.contents;
  } catch {
    // Proxy #2: corsproxy.io
    const u2 = `https://corsproxy.io/?${encodeURIComponent(rawUrl)}`;
    try{
      const r2 = await fetch(u2, { cache: "no-store" });
      if(!r2.ok) throw new Error("corsproxy.io HTTP " + r2.status);
      return await r2.text();
    } catch {
      // Proxy #3: r.jina.ai
      const u3 = `https://r.jina.ai/${rawUrl}`;
      const r3 = await fetch(u3, { cache: "no-store" });
      if(!r3.ok) throw new Error("jina.ai HTTP " + r3.status);
      return await r3.text();
    }
  }
}


async function fetchStooqQuotes(symbols){
  const rawUrl = buildStooqUrl(symbols);
  if(!rawUrl) return [];

  const csvText = await fetchViaProxy(rawUrl);

  // Jeśli proxy zwróci HTML (limit/blokada), nie próbuj udawać CSV
  if(/<html|<!doctype/i.test(csvText)){
    throw new Error("Proxy zwróciło HTML zamiast CSV (limit/blokada). Spróbuj ponownie za chwilę.");
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

  if(!name) return setMsg("Podaj nazwę. Tak, to dalej obowiązuje.");
  if(!symbol) return setMsg("Podaj symbol Stooq. Bez tego nie ma ceny.");
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
  setMsg("Dodano. Teraz możesz kliknąć Odśwież.", "ok");
});

btnReset.addEventListener("click", ()=>{
  if(!confirm("Na pewno wyczyścić wszystko?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_FX);
  setMsg("Wyczyszczone. Jak w głowie po sesji.", "ok");
  render();
});

btnRefresh.addEventListener("click", async ()=>{
  setMsg("");

  const btn = btnRefresh;
  btn.disabled = true;
  btn.textContent = "Odświeżam…";

  try{
    let holdings = loadHoldings();
    if(!Array.isArray(holdings)) holdings = [];

    if(holdings.length === 0){
      setMsg("Nie masz żadnych pozycji. Dodaj coś, potem odświeżaj.", "err");
      return;
    }

    // Czy w ogóle potrzebujemy FX?
    const needsUSD = holdings.some(h => h.ccy === "USD");
    const needsEUR = holdings.some(h => h.ccy === "EUR");

    // Cache: dotyczy tylko FX (żeby nie katować proxy).
    // Ceny akcji też są przez ten sam request, ale MVPowo trzymamy prostą zasadę.
    const fxPrev = loadFx();
    if(fxPrev && hoursSince(fxPrev.ts) < MIN_REFRESH_HOURS){
      setMsg(`Cache: ostatnie odświeżenie było niedawno (min ${MIN_REFRESH_HOURS}h).`, "ok");
      render();
      return;
    }

    const symbols = [...new Set([
      ...holdings.map(h => h.symbol),
      ...(needsUSD ? ["usdpln"] : []),
      ...(needsEUR ? ["eurpln"] : []),
    ])];

    const rows = await fetchStooqQuotes(symbols);

    const priceBySymbol = new Map();
    for(const r of rows){
      const sym = (r.Symbol || r.symbol || "").trim().toLowerCase();
      const close = safeFloat(r.Close ?? r.close);
      if(sym) priceBySymbol.set(sym, close);
    }

    const usdpln = needsUSD ? priceBySymbol.get("usdpln") : undefined;
    const eurpln = needsEUR ? priceBySymbol.get("eurpln") : undefined;

    if(needsUSD && !Number.isFinite(usdpln)){
      throw new Error("Nie udało się pobrać USD/PLN. Proxy/Stooq może chwilowo nie działać.");
    }
    if(needsEUR && !Number.isFinite(eurpln)){
      throw new Error("Nie udało się pobrać EUR/PLN. Proxy/Stooq może chwilowo nie działać.");
    }

    for(const h of holdings){
      const p = priceBySymbol.get((h.symbol || "").toLowerCase());
      h.lastPrice = Number.isFinite(p) ? p : NaN;
      h.lastPriceTs = nowIso();
    }

    saveHoldings(holdings);

    const prev = fxPrev || {};
    saveFx({
      usdpln: needsUSD ? usdpln : prev.usdpln,
      eurpln: needsEUR ? eurpln : prev.eurpln,
      ts: nowIso()
    });

    setMsg("Odświeżono. Tak, działa. Nie, nie klikaj 10x.", "ok");
    render();

  } catch(e){
    setMsg(String(e?.message || e));
    render();
  } finally{
    btn.disabled = false;
    btn.textContent = "Odśwież (Stooq)";
  }
});

// init
render();
