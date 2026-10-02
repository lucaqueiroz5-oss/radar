// Radar: busca as fontes, ranqueia e gera docs/index.html
// Sem dependências: roda em Node 20+.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = process.env.RADAR_FIXTURE; // modo teste: lê feeds locais em vez da internet
const config = JSON.parse(await readFile(join(RAIZ, "config/fontes.json"), "utf8"));
const JANELA_H = config.janela_horas ?? 36;

const SECOES = {
  spfc:     { nome: "São Paulo",        limite: 15 },
  steelers: { nome: "Steelers",         limite: 15 },
  esporte:  { nome: "Esporte",          limite: 16 },
  politica: { nome: "Política",         limite: 20 },
  economia: { nome: "Economia",         limite: 20 },
  varejo:   { nome: "Varejo alimentar", limite: 15 },
  fornecedores: { nome: "Fornecedores", limite: 30 }
};
for (const [k, v] of Object.entries(config.limites ?? {})) if (SECOES[k]) SECOES[k].limite = v;
const MAX_VEICULO = config.max_por_veiculo ?? 6;
const MAX_EMPRESA = config.max_por_empresa ?? 4;
// homônimos e falsos positivos (Marion Nestle, Jade Cargill, "€3m")
const EXCLUIR = /marion nestle|jade cargill|[€$£]\s?\d+(\.\d+)?m\b/i;
// Varejo: só entra manchete com termo do setor (evita notícia fora do tema)
const TEMA_VAREJO = /supermerc|atacarej|varej|hipermerc|assa[ií]|carrefour|\bgpa\b|p[ãa]o de a[çc][úu]car|mateus|atacad[ãa]o|abras|cesta b[áa]sica|pre[çc]o d[oa]s? aliment|alimentos|food|grocer|supermarket|walmart|kroger|aldi|tesco|costco|ahold|lidl|retail/i;
// Times: só entra manchete sobre o time (o veículo especializado conta, ex.: Steelers Depot, Arquibancada Tricolor)
const TEMAS = {
  varejo: TEMA_VAREJO,
  fornecedores: /nestl[eé]|reckitt|vestacy|nivea|beiersdorf|gomes da costa|cargill|\bbic\b|\b3m\b|condor|haleon|bracell|pronova|energizer|brown-forman|notco|ferrara/i,
  steelers: /steeler|steel curtain|\bmccarthy\b|t\.?\s?j\.? watt|jalen ramsey|darnell washington|jaylen warren|rico dowdle|derrick harmon|heyward|highsmith|freiermuth|art rooney|acrisure stadium/i,
  spfc: /tricolor|\bspfc\b|s[ãa]o paulo fc|morumb|dorival|calleri|s[ãa]o paulo (x|vs\.?|contra|enfrenta|vence|perde|empata|visita|acerta|contrata|renova|demite|treina|joga|negocia)\b|(do|no|o|pelo|ao|contra o|para o) s[ãa]o paulo\b/i
};

/* ---------- busca ---------- */
function urlDa(fonte) {
  if (fonte.rss) return fonte.rss;
  const en = fonte.lang === "en";
  const q = encodeURIComponent(`${fonte.gn} when:${fonte.dias ?? 1}d`);
  return en
    ? `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`
    : `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
}

async function baixar(fonte) {
  if (FIXTURE) return readFile(join(FIXTURE, fonte.rss ? "rss.xml" : "gn.xml"), "utf8");
  const r = await fetch(urlDa(fonte), {
    headers: { "user-agent": "Mozilla/5.0 (RadarBot; +https://github.com)", accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function emLotes(lista, n, fn) {
  const saida = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < lista.length) { const k = i++; saida[k] = await fn(lista[k]); }
  }));
  return saida;
}

/* ---------- parser RSS/Atom simples ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decod = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(\w+);/g, (m, e) => ENT[e] ?? m);
const semHtml = s => decod(decod(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function tag(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, "i"));
  return m ? m[1] : "";
}
function attr(bloco, nome, a) {
  const m = bloco.match(new RegExp(`<${nome}[^>]*\\s${a}="([^"]*)"`, "i"));
  return m ? decod(m[1]) : "";
}

function parse(xml, fonte) {
  const blocos = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocos.map(b => {
    let titulo = semHtml(tag(b, "title"));
    let veiculo = semHtml(tag(b, "source")) || fonte.nome;
    const link = semHtml(tag(b, "link")) || attr(b, "link", "href");
    const data = new Date(semHtml(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
    // Google News: "Manchete - Veículo"
    if (!fonte.rss) {
      const corte = titulo.lastIndexOf(" - ");
      if (corte > 20) { veiculo = semHtml(tag(b, "source")) || titulo.slice(corte + 3); titulo = titulo.slice(0, corte); }
    }
    let resumo = fonte.rss ? semHtml(tag(b, "description") || tag(b, "summary") || tag(b, "content")) : "";
    if (resumo.length > 260) resumo = resumo.slice(0, 250).replace(/\s\S*$/, "") + "…";
    return { titulo, link, veiculo, resumo, data: isNaN(data) ? null : data.toISOString(),
             secao: fonte.secao, fonte: fonte.nome, lang: fonte.lang, peso: fonte.peso ?? 1, setorista: !!fonte.setorista, destaque: !!fonte.destaque, dedicado: !!fonte.dedicado, empresa: fonte.empresa ?? "", dias: fonte.dias ?? 1 };
  }).filter(n => n.titulo && n.link);
}

/* ---------- ranking ---------- */
const chave = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 70);
function ranquear(noticias, agora) {
  const vistos = new Map();
  for (const n of noticias) {
    if (!n.data) continue;
    // descarta páginas de categoria/arquivo que o Google News às vezes indexa como notícia
    if (/^arquivos?\b|^(categoria|tag)\b| - giro news$/i.test(n.titulo) || n.titulo.split(/\s+/).length < 4) continue;
    const idadeH = (agora - new Date(n.data)) / 36e5;
    if (idadeH < -1 || idadeH > Math.max(JANELA_H, n.dias * 24)) continue;
    n.score = Math.max(0, 1 - idadeH / JANELA_H) * 10 + n.peso * 2 + (n.setorista ? 2 : 0) + (n.destaque ? 6 : 0) + (n.resumo ? 0.5 : 0);
    const k = chave(n.titulo);
    const ja = vistos.get(k);
    if (!ja || ja.score < n.score) vistos.set(k, n);
  }
  const porSecao = {};
  for (const s of Object.keys(SECOES)) {
    const porVeiculo = {}, porEmpresa = {};
    porSecao[s] = [...vistos.values()]
      .filter(n => n.secao === s && (n.dedicado || !TEMAS[s] || TEMAS[s].test(`${n.titulo} ${n.veiculo}`)) && !EXCLUIR.test(n.titulo))
      .sort((a, b) => b.score - a.score)
      .filter(n => { if (n.empresa) { porEmpresa[n.empresa] = (porEmpresa[n.empresa] ?? 0) + 1; if (porEmpresa[n.empresa] > (config.limite_empresa?.[n.empresa] ?? MAX_EMPRESA)) return false; } const v = chave(n.veiculo); porVeiculo[v] = (porVeiculo[v] ?? 0) + 1; return n.destaque || porVeiculo[v] <= MAX_VEICULO; })
      .slice(0, SECOES[s].limite);
  }
  return porSecao;
}

/* ---------- HTML ---------- */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hora = (d, extra = 0) => new Date(d.getTime() + extra).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const dia = d => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long", year: "numeric" });

function linhaFonte(n) {
  const extras = [n.setorista ? "setorista" : "", n.lang === "en" ? "em inglês" : ""].filter(Boolean).join(", ");
  return `<a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.veiculo)}</a>${extras ? ` <span class="x">(${extras})</span>` : ""}<time datetime="${n.data}"></time>`;
}
const cartao = n => `<article class="story">${n.empresa ? `<span class="tag">${esc(n.empresa)}</span>` : ""}<h4><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.titulo)}</a></h4>${n.resumo ? `<p>${esc(n.resumo)}</p>` : ""}<div class="src">${linhaFonte(n)}</div></article>`;
const destaque = n => `<article class="lead">${n.empresa ? `<span class="tag">${esc(n.empresa)}</span>` : ""}<h4><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.titulo)}</a></h4>${n.resumo ? `<p>${esc(n.resumo)}</p>` : ""}<div class="src">${linhaFonte(n)}</div></article>`;

function setoristasHtml(id) {
  const lista = config.setoristas?.[id];
  if (!lista?.length) return "";
  return `<div class="beat"><span>Setoristas que o Radar acompanha</span>${lista.map(p => p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener"><b>${esc(p.nome)}</b> ${esc(p.veiculo)}</a>`
    : `<em><b>${esc(p.nome)}</b> ${esc(p.veiculo)}</em>`).join("")}</div>`;
}

function secaoHtml(id, itens) {
  if (!itens.length) return `<section class="cat ${id}" data-s="${id}"><div class="cat-head"><h3>${SECOES[id].nome}</h3></div><p class="vazio">Nenhuma notícia nova nas últimas ${JANELA_H} horas.</p></section>`;
  const [lead, ...resto] = itens;
  return `<section class="cat ${id}" data-s="${id}"><div class="cat-head"><h3>${SECOES[id].nome}</h3><p>${itens.length} notícias</p></div>${setoristasHtml(id)}
<div class="cat-body">${destaque(lead)}<div class="rest">${resto.map(cartao).join("")}</div></div></section>`;
}

function poster(id, itens) {
  const n = itens[0];
  const nome = id === "spfc" ? "São Paulo" : "Steelers";
  return `<article class="poster ${id === "spfc" ? "spfc" : "steel"}"><div class="when">${n ? "Última notícia" : "Sem novidades agora"}</div><div class="text"><h2>${nome}</h2>${n ? `<a class="vs" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.titulo)}</a><div class="info">${esc(n.veiculo)}${n.setorista ? ", setorista" : ""}<time datetime="${n.data}"></time></div>` : ""}</div></article>`;
}

function pagina(porSecao, agora, status) {
  const total = Object.values(porSecao).reduce((a, l) => a + l.length, 0);
  const ok = status.filter(s => s.ok).length;
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Radar, atualizado às ${hora(agora)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">
<header class="masthead"><h1 class="wordmark">Radar<span class="dotrow" aria-hidden="true"><b style="background:var(--esporte)"></b><b style="background:var(--politica)"></b><b style="background:var(--economia)"></b><b style="background:var(--varejo)"></b></span></h1>
<div class="dateline"><strong>${dia(agora)}</strong>Atualiza sozinho a cada hora</div></header>
<div class="pulse"><div><span>Atualizado às</span><strong>${hora(agora)}</strong></div><div><span>Idade desta edição</span><strong id="idade" data-gerado="${agora.toISOString()}">agora</strong></div><div><span>Notícias na edição</span><strong>${total}</strong></div><div><span>Fontes respondendo</span><strong>${ok} de ${status.length}</strong></div></div>
<div class="teams">${poster("spfc", porSecao.spfc)}${poster("steelers", porSecao.steelers)}</div>
<nav class="portals" aria-label="Seus portais"><span class="plabel">Seus portais</span>
<a href="https://www.uol.com.br/" target="_blank" rel="noopener"><i style="--p:#F2A900">U</i>UOL</a>
<a href="https://ge.globo.com/sp/futebol/times/sao-paulo/" target="_blank" rel="noopener"><i style="--p:#06AA48">ge</i>ge São Paulo</a>
<a href="https://g1.globo.com/" target="_blank" rel="noopener"><i style="--p:#C4170C">g1</i>g1</a>
<a href="https://oglobo.globo.com/politica/" target="_blank" rel="noopener"><i style="--p:#1A5EFF">g</i>O Globo</a>
<a href="https://valor.globo.com/" target="_blank" rel="noopener"><i style="--p:#0E5C5A">V</i>Valor</a>
<a href="https://pipelinevalor.globo.com/" target="_blank" rel="noopener"><i style="--p:#0E5C5A">P</i>Pipeline</a>
<a href="https://braziljournal.com/" target="_blank" rel="noopener"><i style="--p:#E8A200">B</i>Brazil Journal</a>
<a href="https://gironews.com/" target="_blank" rel="noopener"><i style="--p:#075192">G</i>Giro News</a>
<a href="https://www.cnnbrasil.com.br/" target="_blank" rel="noopener"><i style="--p:#CC0000">CNN</i>CNN Brasil</a>
<a href="https://www.steelers.com/news/" target="_blank" rel="noopener"><i style="--p:#0B1626;color:#FFB612">P</i>Steelers.com</a>
<a href="https://www.post-gazette.com/sports/steelers" target="_blank" rel="noopener"><i style="--p:#1B1B1B">PG</i>Post-Gazette</a>
<a href="https://www.espn.com/nfl/team/_/name/pit/pittsburgh-steelers" target="_blank" rel="noopener"><i style="--p:#D00">E</i>ESPN Steelers</a></nav>
<nav class="filters" aria-label="Filtrar editorias"><button data-f="all" aria-pressed="true">Tudo</button><button data-f="meus">Meus times</button><button data-f="esporte">Esporte</button><button data-f="politica">Política</button><button data-f="economia">Economia</button><button data-f="varejo">Varejo alimentar</button><button data-f="fornecedores">Fornecedores</button></nav>
<main>${Object.keys(SECOES).map(s => secaoHtml(s, porSecao[s])).join("")}</main>
<footer>Manchetes coletadas automaticamente de Google News e feeds RSS; clique para ler no veículo. Valor e O Globo têm paywall. Fontes que falharam nesta rodada: ${esc(status.filter(s => !s.ok).map(s => s.nome).join(", ") || "nenhuma")}.</footer>
</div><script>${JS}</script></body></html>`;
}

const CSS = `:root{--bg:#EEF1F5;--surface:#fff;--ink:#12233D;--muted:#5A6A80;--line:#D5DCE5;--chip:#E1E7EE;--esporte:#0F6B45;--politica:#8E2333;--economia:#2244C4;--varejo:#E2A20B;--varejo-ink:#2B1D00;--spfc:#E0192B;--steel:#FFB612;--night:#0B1626;--display:"Bricolage Grotesque",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--serif:"Source Serif 4",Georgia,serif;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--bg:#0C1522;--surface:#142133;--ink:#E8EDF4;--muted:#9BABC0;--line:#24344A;--chip:#1C2B40;--esporte:#2FA874;--politica:#D2556A;--economia:#6F8DFF;--varejo:#F0B532}}
*,*::before,*::after{box-sizing:inherit}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--display);-webkit-font-smoothing:antialiased;line-height:1.45}a{color:inherit}
.wrap{max-width:1240px;margin:0 auto;padding:0 24px 72px}
.masthead{display:grid;grid-template-columns:1fr auto;align-items:end;gap:16px;padding:30px 0 20px}
.wordmark{margin:0;font-weight:800;font-variation-settings:"wdth" 75;font-size:clamp(64px,12vw,148px);line-height:.78;letter-spacing:-.035em}
.dotrow{display:inline-flex;gap:.05em;margin-left:.06em;vertical-align:.06em}.dotrow b{width:.16em;height:.16em;border-radius:50%;display:block}
.dateline{text-align:right;font-size:15px;color:var(--muted)}.dateline strong{display:block;color:var(--ink);font-size:clamp(18px,2.2vw,24px);font-weight:700;font-variation-settings:"wdth" 85}
.pulse{display:flex;overflow-x:auto;background:var(--ink);color:var(--bg);border-radius:14px;margin-bottom:22px}
.pulse div{flex:1 0 auto;padding:12px 20px;display:flex;flex-direction:column;gap:2px;border-right:1px solid color-mix(in srgb,var(--bg) 18%,transparent)}.pulse div:last-child{border-right:0}
.pulse span{font-size:13px;opacity:.72}.pulse strong{font-size:21px;font-weight:700;font-variation-settings:"wdth" 82;white-space:nowrap}
.teams{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px}
.poster{position:relative;overflow:hidden;border-radius:22px;min-height:290px;padding:26px 28px;color:#fff;display:flex;flex-direction:column;justify-content:space-between;isolation:isolate}
.poster .when{font-size:15px;font-weight:600;opacity:.9}.poster h2{margin:0;font-weight:800;font-variation-settings:"wdth" 75;font-size:clamp(46px,6.4vw,88px);line-height:.85;letter-spacing:-.03em}
.poster .vs{display:block;font-size:clamp(18px,1.9vw,23px);font-weight:700;line-height:1.2;margin:14px 0 6px;text-decoration:none}.poster .vs:hover{text-decoration:underline}
.poster .info{font-size:14.5px;opacity:.85}.poster .text{position:relative;max-width:62%}
.poster.spfc{background:#121212}.poster.spfc::before{content:"";position:absolute;z-index:-1;right:-16%;top:-30%;width:44%;height:170%;transform:rotate(18deg);background:linear-gradient(90deg,var(--spfc) 0 33.3%,#fff 33.3% 66.6%,#121212 66.6%)}.poster.spfc .vs{color:#FF8A94}
.poster.steel{background:var(--night)}.poster.steel::before,.poster.steel::after{content:"";position:absolute;z-index:-1;right:-26%;bottom:-48%;width:62%;aspect-ratio:1;border-radius:50%}.poster.steel::before{background:var(--steel)}.poster.steel::after{box-shadow:0 0 0 22px var(--night),0 0 0 34px var(--steel)}.poster.steel .vs{color:var(--steel)}
.portals{display:flex;align-items:center;gap:8px;overflow-x:auto;padding:4px 0 16px}.plabel{flex:0 0 auto;font-size:14px;color:var(--muted);margin-right:6px}
.portals a{flex:0 0 auto;display:flex;align-items:center;gap:9px;text-decoration:none;font-size:15px;font-weight:600;padding:5px 15px 5px 5px;border-radius:999px;background:var(--surface);border:1px solid var(--line)}.portals a:hover{border-color:var(--ink)}
.portals i{font-style:normal;display:grid;place-items:center;min-width:30px;height:30px;padding:0 6px;border-radius:999px;background:var(--p);color:#fff;font-size:12px;font-weight:800}
.filters{position:sticky;top:0;z-index:10;display:flex;gap:8px;overflow-x:auto;padding:12px 0;background:var(--bg)}
.filters button{flex:0 0 auto;font:inherit;font-size:15px;font-weight:600;border:0;border-radius:999px;padding:9px 18px;background:var(--chip);color:var(--ink);cursor:pointer}.filters button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}
a:focus-visible,button:focus-visible{outline:3px solid var(--economia);outline-offset:2px}
section.cat{margin-top:34px}.cat.spfc{--c:var(--spfc)}.cat.steelers{--c:#B07D00}.cat.esporte{--c:var(--esporte)}.cat.politica{--c:var(--politica)}.cat.economia{--c:var(--economia)}.cat.varejo{--c:var(--varejo)}
.cat.steelers .lead{background:var(--night);color:var(--steel)}
.cat-head{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}.cat-head h3{margin:0;font-weight:800;font-variation-settings:"wdth" 75;font-size:clamp(40px,5.5vw,68px);line-height:.9;letter-spacing:-.025em;color:var(--c)}.cat-head p{margin:0;color:var(--muted);font-size:15px}
.cat-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;align-items:start}
.lead{background:var(--c);color:#fff;border-radius:20px;padding:26px 28px 24px;position:sticky;top:76px}.cat.varejo .lead{color:var(--varejo-ink)}
.lead h4{margin:0 0 14px;font-size:clamp(26px,3vw,36px);line-height:1.08;font-weight:700;font-variation-settings:"wdth" 88}.lead h4 a{text-decoration:none}.lead h4 a:hover{text-decoration:underline}
.lead p{margin:0 0 18px;font-family:var(--serif);font-size:18px;line-height:1.55}.lead .src{font-size:14px;opacity:.88}
.rest{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.story{background:var(--surface);border-radius:16px;padding:18px 20px;border-top:4px solid var(--c);display:flex;flex-direction:column}
.story h4{margin:0 0 8px;font-size:18px;line-height:1.24;font-weight:700}.story h4 a{text-decoration:none}.story h4 a:hover{color:var(--c)}
.story p{margin:0 0 12px;font-family:var(--serif);font-size:16px;line-height:1.5}.story .src{margin-top:auto;font-size:13.5px;color:var(--muted)}
.src a{text-underline-offset:3px}.x{opacity:.8}.vazio{color:var(--muted)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px;max-width:72ch}
.beat{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:-4px 0 16px}.beat span{font-size:14px;color:var(--muted);margin-right:4px}
.beat a,.beat em{font-style:normal;font-size:14px;padding:6px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line);color:var(--muted);text-decoration:none}.beat b{color:var(--ink);font-weight:700}.beat a:hover{border-color:var(--c)}
.cat.fornecedores{--c:#0E7C86}.tag{display:inline-block;font-size:13px;font-weight:700;color:var(--c);margin-bottom:6px}.lead .tag{color:inherit;opacity:.85}
.hidden{display:none!important}
@media (max-width:900px){.cat-body{grid-template-columns:1fr}.lead{position:static}}
@media (max-width:720px){.wrap{padding:0 14px 56px}.teams{grid-template-columns:1fr}.poster{min-height:250px;padding:22px}.poster .text{max-width:74%}.masthead{grid-template-columns:1fr}.dateline{text-align:left}.lead{padding:22px}}`;

const JS = `
const rel=iso=>{const m=Math.round((Date.now()-new Date(iso))/6e4);if(m<1)return"agora";if(m<60)return"há "+m+" min";const h=Math.round(m/60);return"há "+h+" h"};
const marcar=()=>document.querySelectorAll("time[datetime]").forEach(t=>t.textContent=", "+rel(t.dateTime));marcar();setInterval(marcar,6e4);
const bt=document.querySelectorAll(".filters button"),secs=document.querySelectorAll("section.cat");
function f(v){bt.forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.f===v)));secs.forEach(s=>{const id=s.dataset.s;const show=v==="all"||(v==="meus"&&(id==="spfc"||id==="steelers"))||(v==="esporte"&&["spfc","steelers","esporte"].includes(id))||v===id;s.classList.toggle("hidden",!show)});try{localStorage.setItem("radar-f",v)}catch(e){}}
bt.forEach(b=>b.onclick=()=>f(b.dataset.f));let s="all";try{s=localStorage.getItem("radar-f")||"all"}catch(e){}f(s);
const idade=()=>{const el=document.getElementById("idade");if(!el)return;const m=Math.round((Date.now()-new Date(el.dataset.gerado))/6e4);el.textContent=m<1?"agora":m<60?m+" min":Math.floor(m/60)+" h "+(m%60)+" min";el.style.color=m>90?"#FF8A94":""};idade();setInterval(idade,3e4);\nsetInterval(()=>{if(document.visibilityState==="visible")location.reload()},10*6e4);`;

/* ---------- execução ---------- */
const agora = new Date();
const status = [];
const listas = await emLotes(config.fontes, 6, async fonte => {
  try {
    const itens = parse(await baixar(fonte), fonte);
    status.push({ nome: fonte.nome, ok: true, itens: itens.length });
    return itens;
  } catch (e) {
    status.push({ nome: fonte.nome, ok: false, erro: String(e.message || e) });
    console.warn(`Falhou: ${fonte.nome} (${e.message || e})`);
    return [];
  }
});
const porSecao = ranquear(listas.flat(), agora);
await mkdir(join(RAIZ, "docs"), { recursive: true });
await writeFile(join(RAIZ, "docs/index.html"), pagina(porSecao, agora, status));
await writeFile(join(RAIZ, "docs/noticias.json"), JSON.stringify({ geradoEm: agora.toISOString(), status, porSecao }, null, 2));
const total = Object.values(porSecao).reduce((a, l) => a + l.length, 0);
console.log(`Radar gerado: ${total} notícias, ${status.filter(s => s.ok).length}/${status.length} fontes ok.`);
if (status.every(s => !s.ok)) process.exit(1);
