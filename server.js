// server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ====== PUERTO Y BASE INTERNA (CLAVE EN RENDER) ======
const PORT = process.env.PORT || 3000;
const INTERNAL_BASE = `http://127.0.0.1:${PORT}`;

// Directorio de plantillas (HTML, imágenes y PDFs estáticos)
const TPL_DIR = path.join(__dirname, 'templates');

// PDFs estáticos a insertar
const STATIC_PDFS = {
  afterIndex2: [
    path.join(TPL_DIR, 'anexo1.pdf'),
    path.join(TPL_DIR, 'anexo2.pdf'),
  ],
  afterIndex3: [
    path.join(TPL_DIR, 'anexo3.pdf'),
  ]
};

// Servir HTML/Imágenes
app.use('/templates', express.static(TPL_DIR, { extensions: ['html'] }));

app.get('/health', (_req, res) => res.send('ok'));

// ----------------- Helpers -----------------

// ⚠️ USAR BASE INTERNA, NO EL HOST PÚBLICO
function buildPageUrl(_req, filename, data = {}) {
  const base = `${INTERNAL_BASE}/templates/${filename}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function renderUrlToPdfBuffer(url) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: path.join(__dirname, 'chrome-browser', 'chrome', 'linux-142.0.7444.59', 'chrome-linux64', 'chrome'),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process'
    ],
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' }
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

async function mergePdfBuffers(buffers) {
  const out = await PDFDocument.create();
  for (const b of buffers) {
    if (!b || !b.length) continue;
    const src = await PDFDocument.load(b);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));
  }
  return await out.save();
}

function readStaticPdfBuffer(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath);
}

// ----------------- Fórmulas -----------------
// ----------------- Fórmulas -----------------
// ----------------- Helpers financieros -----------------
function toNum(v) {
  if (v === undefined || v === null || v === '') return NaN;
  const n = Number(String(v).toString().replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? NaN : n;
}

// NPV de un flujo anual (t0..tn) a tasa r (anual)
function npv(rate, flows) {
  return flows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}

// IRR por Newton-Raphson con fallback a búsqueda
function irr(flows, guess = 0.1) {
  const maxIter = 100;
  const tol = 1e-7;

  // Derivada de NPV con respecto a r
  const dNPV = (r) =>
    flows.reduce((acc, cf, t) => {
      if (t === 0) return acc;
      return acc - (t * cf) / Math.pow(1 + r, t + 1);
    }, 0);

  let r = guess;
  for (let i = 0; i < maxIter; i++) {
    const f = npv(r, flows);
    const df = dNPV(r);
    if (Math.abs(df) < 1e-12) break;
    const rNext = r - f / df;
    if (!isFinite(rNext)) break;
    if (Math.abs(rNext - r) < tol) return rNext;
    r = rNext;
  }

  // Fallback: búsqueda en rango [-0.9, 5] (−90% a 500%)
  let low = -0.9, high = 5.0, fLow = npv(low, flows), fHigh = npv(high, flows);
  if (fLow * fHigh > 0) return NaN; // no garantiza raíz
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid, flows);
    if (Math.abs(fMid) < tol) return mid;
    if (fLow * fMid < 0) {
      high = mid; fHigh = fMid;
    } else {
      low = mid; fLow = fMid;
    }
  }
  return NaN;
}

// Payback simple (años hasta recuperar inversión) a partir de flujos anuales
function paybackYears(flows) {
  let cum = 0;
  for (let t = 0; t < flows.length; t++) {
    cum += flows[t];
    if (cum >= 0) {
      // Interpolación lineal dentro del año t
      const prevCum = cum - flows[t];
      const frac = flows[t] !== 0 ? (0 - prevCum) / flows[t] : 0;
      return t - 1 + Math.max(0, Math.min(1, frac));
    }
  }
  return NaN; // no se recupera en el horizonte evaluado
}

// Formato miles Colombia
function formatCO(v) {
  const n = toNum(v);
  if (isNaN(n)) return '';
  return n.toLocaleString('es-CO');
}

// ----------------- Fórmulas -----------------
function computeFields(input = {}) {
  const out = { ...input };

  // === CONSTANTES EDITABLES ===
  const YEARS = 25;          // horizonte de evaluación
  const DISCOUNT = 0.12;     // tasa de descuento anual (12%)
  const SAVINGS_RATE = 0.80; // % de la factura que realmente se ahorra (fijos dejan ~20%)
  const O_M_RATE = 0.01;     // O&M anual como % de la inversión (1%)
  const DEGRAD = 0.005;      // degradación anual de ahorro (0.5%/año). Pon 0 si no quieres degradación
  const VAT = 0.19;          // IVA Colombia 19%
  const MATERIALES_SHARE = 0.60; // % de la inversión que corresponde a materiales (para IVA)
  const TAX_BENEFIT_MODE = 'YEAR1'; // 'YEAR1' o 'DISTRIB_5Y' (distribuir beneficio tributario 5 años)
  // ============================

  // Fecha local CO
  if (!out.FECHA) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Bogota' };
    out.FECHA = new Date().toLocaleDateString('es-CO', options);
  }

  // Números base
  const ENERGIA = toNum(out.ENERGIA);   // kWh/mes (desde tu celda 440)
  const FACTURA = toNum(out.FACTURA);   // $/mes pre-solar (si no viene, lo dejamos NaN)

  // Potencia, paneles, inversores (tus reglas)
  if (!('POTENCIA' in out)) {
    const pot = isNaN(ENERGIA) ? NaN : (ENERGIA * 1.2) / (4.2 * 30 * 0.81);
    out.POTENCIA = isNaN(pot) ? '' : (Math.round(pot * 100) / 100).toString();
  }
  const POTENCIA = toNum(out.POTENCIA);

  if (!('PANELES' in out)) {
    const p = isNaN(POTENCIA) ? NaN : Math.ceil((POTENCIA * 1000) / 645);
    out.PANELES = isNaN(p) ? '' : String(p);
  }

  if (!('INVERSORES' in out)) {
    const inv = isNaN(POTENCIA) ? NaN : Math.ceil(POTENCIA / 1.25);
    out.INVERSORES = isNaN(inv) ? '' : String(inv);
  }

  if (!('INVERSION_TOTAL' in out)) {
    const invTot = isNaN(POTENCIA) ? NaN : POTENCIA * 3_550_000;
    out.INVERSION_TOTAL = isNaN(invTot) ? '' : String(Math.round(invTot));
  }
  const INVERSION_TOTAL = toNum(out.INVERSION_TOTAL);

  // IVA de materiales
  // Base materiales: si no te llega `MATERIALES_BASE` por input, usamos un % de la inversión total
  const MATERIALES_BASE = ('MATERIALES_BASE' in out) ? toNum(out.MATERIALES_BASE)
                        : (isNaN(INVERSION_TOTAL) ? NaN : INVERSION_TOTAL * MATERIALES_SHARE);
  const IVA_MATERIALES = isNaN(MATERIALES_BASE) ? NaN : MATERIALES_BASE * VAT;
  out.IVA_MATERIALES = formatCO(IVA_MATERIALES);

  // Beneficio tributario (como en tu Excel: 50% de la inversión)
  if (!('BENEFICIO_TRIBUTARIO' in out)) {
    const ben = isNaN(INVERSION_TOTAL) ? NaN : INVERSION_TOTAL / 2;
    out.BENEFICIO_TRIBUTARIO = isNaN(ben) ? '' : String(Math.round(ben));
  }
  const BENEFICIO_TRIBUTARIO = toNum(out.BENEFICIO_TRIBUTARIO);

  // Ahorro mensual estimado
  // Si tienes FACTURA mensual, usamos un % de ahorro (configurable). Si no, lo dejamos NaN.
  const ahorroMensual0 = isNaN(FACTURA) ? NaN : FACTURA * SAVINGS_RATE;

  // Construcción de flujos ANUALES
  // t=0: -inversión (puedes sumar o no el IVA materiales si aplica al desembolso)
  // t>=1: +ahorro anual degradado - O&M + (beneficio tributario en el año que corresponda)
  const flows = [];
  // t=0
  flows.push(isNaN(INVERSION_TOTAL) ? NaN : -INVERSION_TOTAL);
  // años 1..YEARS
  for (let y = 1; y <= YEARS; y++) {
    // ahorro anual con degradación
    const ahMes = isNaN(ahorroMensual0) ? 0 : ahorroMensual0 * Math.pow(1 - DEGRAD, y - 1);
    const ahorroAnual = ahMes * 12;

    // O&M anual
    const oym = isNaN(INVERSION_TOTAL) ? 0 : INVERSION_TOTAL * O_M_RATE;

    // beneficio tributario (si se toma en Y1 o distribuido 5 años)
    let benY = 0;
    if (!isNaN(BENEFICIO_TRIBUTARIO)) {
      if (TAX_BENEFIT_MODE === 'YEAR1' && y === 1) benY = BENEFICIO_TRIBUTARIO;
      if (TAX_BENEFIT_MODE === 'DISTRIB_5Y' && y <= 5) benY = BENEFICIO_TRIBUTARIO / 5;
    }

    const cf = ahorroAnual - oym + benY;
    flows.push(cf);
  }

  // Ahorro total 25 años (solo suma de ahorros brutos, sin O&M ni beneficios tributarios)
  if (!('AHORRO_TOTAL' in out)) {
    let sumaAhorros = 0;
    if (!isNaN(ahorroMensual0)) {
      for (let y = 1; y <= YEARS; y++) {
        const ahMes = ahorroMensual0 * Math.pow(1 - DEGRAD, y - 1);
        sumaAhorros += ahMes * 12;
      }
    }
    out.AHORRO_TOTAL = String(Math.round(sumaAhorros));
  }

  // B/C ratio = PV(Beneficios) / PV(Costos)
  // Definimos beneficios: ahorros (y beneficio tributario si lo tratas como beneficio).
  // Costos: inversión inicial (y O&M) con signo positivo en el denominador.
  (function computeBC() {
    // Beneficios anuales (sin signos): ahorro + (beneficio tributario si aplica ese año)
    const benFlows = [0];
    const costFlows = [isNaN(INVERSION_TOTAL) ? 0 : INVERSION_TOTAL]; // costo t0 positivo para PV
    for (let y = 1; y <= YEARS; y++) {
      const ahMes = isNaN(ahorroMensual0) ? 0 : ahorroMensual0 * Math.pow(1 - DEGRAD, y - 1);
      const ahorroAnual = ahMes * 12;
      let benY = 0;
      if (!isNaN(BENEFICIO_TRIBUTARIO)) {
        if (TAX_BENEFIT_MODE === 'YEAR1' && y === 1) benY = BENEFICIO_TRIBUTARIO;
        if (TAX_BENEFIT_MODE === 'DISTRIB_5Y' && y <= 5) benY = BENEFICIO_TRIBUTARIO / 5;
      }
      benFlows.push(ahorroAnual + benY);
      // O&M como costo anual
      const oym = isNaN(INVERSION_TOTAL) ? 0 : INVERSION_TOTAL * O_M_RATE;
      costFlows.push(oym);
    }
    const pvBen = npv(DISCOUNT, benFlows);
    const pvCost = npv(DISCOUNT, costFlows);
    const bc = pvCost > 0 ? pvBen / pvCost : NaN;
    out.BC = isFinite(bc) ? bc.toFixed(2) : '';
  })();

  // IRR
  const tir = irr(flows);
  out.TIR = isFinite(tir) ? (tir * 100).toFixed(2) + '%' : '';

  // Payback (años)
  const pb = paybackYears(flows);
  out.RECUPERACION_INVERSION = isFinite(pb) ? pb.toFixed(1) : '';

  // ROI simple (beneficios netos / inversión)
  const totalIn = flows.slice(1).reduce((a, b) => a + b, 0);
  const roi = isNaN(INVERSION_TOTAL) ? NaN : (totalIn + flows[0]) / Math.abs(flows[0]); // (sum cf)/inversión
  out.ROI = isFinite(roi) ? (roi * 100).toFixed(1) + '%' : '';

  // ------- Formateos finales -------
  if (!('ENERGIA' in out)) out.ENERGIA = isNaN(ENERGIA) ? '' : String(ENERGIA);
  if (!('FACTURA' in out)) out.FACTURA = isNaN(FACTURA) ? '' : String(FACTURA);

  out.INVERSION_TOTAL = formatCO(out.INVERSION_TOTAL);
  out.BENEFICIO_TRIBUTARIO = formatCO(out.BENEFICIO_TRIBUTARIO);
  out.AHORRO_TOTAL = formatCO(out.AHORRO_TOTAL);
  out.FACTURA = formatCO(out.FACTURA);
  out.ENERGIA = formatCO(out.ENERGIA);
  out.PAGO1 = formatCO(out.PAGO1);
  out.PAGO2 = formatCO(out.PAGO2);
  out.PAGO3 = formatCO(out.PAGO3);
  out.PAGO4 = formatCO(out.PAGO4);
  out.IVA_MATERIALES = formatCO(out.IVA_MATERIALES);

  return out;
}


// ----------------- Endpoint principal -----------------
app.post('/render/cotizacion', async (req, res) => {
  try {
    const inputData = req.body?.data || {};
    const data = computeFields(inputData);

    const urlIndex  = buildPageUrl(req, 'index.html', {
      EMPRESA: data.EMPRESA,
      CLIENTE: data.CLIENTE,
      CIUDAD: data.CIUDAD,
      FECHA: data.FECHA,
      POTENCIA: data.POTENCIA,
      ENERGIA: data.ENERGIA,
      FACTURA: data.FACTURA
    });

    const urlIndex2 = buildPageUrl(req, 'index2.html', {
      PANELES: data.PANELES,
      INVERSORES: data.INVERSORES
    });

    const urlIndex3 = buildPageUrl(req, 'index3.html', {
      INVERSION_TOTAL: data.INVERSION_TOTAL,
      BENEFICIO_TRIBUTARIO: data.BENEFICIO_TRIBUTARIO,
      RECUPERACION_INVERSION: data.RECUPERACION_INVERSION,
      TIR: data.TIR,
      BC: data.BC,
      AHORRO_TOTAL: data.AHORRO_TOTAL,
      ENERGIA: data.ENERGIA,
      AHORRO_MENSUAL: data.AHORRO_TOTAL || '',
      FACTUIRA: data.FACTURA || '',
      PAGO1: data.PAGO1 || '',
      PAGO2: data.PAGO2 || '',
      PAGO3: data.PAGO3 || '',
      PAGO4: data.PAGO4 || '',
      IVA_MATERIALES: data.IVA_MATERIALES || ''
    });

    // (Opcional) log para depurar en Render
    console.log('Rendering URLs:', urlIndex, urlIndex2, urlIndex3);

    const pdfIndex  = await renderUrlToPdfBuffer(urlIndex);
    const pdfIndex2 = await renderUrlToPdfBuffer(urlIndex2);
    const pdfIndex3 = await renderUrlToPdfBuffer(urlIndex3);

    const annexAfter2 = STATIC_PDFS.afterIndex2.map(readStaticPdfBuffer).filter(Boolean);
    const annexAfter3 = STATIC_PDFS.afterIndex3.map(readStaticPdfBuffer).filter(Boolean);

    const merged = await mergePdfBuffers([
      pdfIndex,
      pdfIndex2,
      ...annexAfter2,
      pdfIndex3,
      ...annexAfter3
    ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="cotizacion.pdf"');
    res.send(Buffer.from(merged));
  } catch (err) {
    console.error('Render error:', err);
    const wantsJson = req.query.debug === '1';
    if (wantsJson) {
      return res.status(500).json({ error: 'Render failed', detail: String(err && err.message || err) });
    }
    return res.status(500).send('Render failed');
  }
});

// Puerto para Render
app.listen(PORT, () => {
  console.log('PDF service on http://localhost:' + PORT);
});
