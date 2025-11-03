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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
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
function computeFields(input = {}) {
  const out = { ...input };

  if (!out.FECHA) {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    out.FECHA = `${dd}/${mm}/${yyyy}`;
  }

  const num = (v) => {
    if (v === undefined || v === null || v === '') return NaN;
    const n = Number(String(v).toString().replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? NaN : n;
  };

  const ENERGIA = num(out.ENERGIA);
  const FACTURA = num(out.FACTURA);

  if (!('POTENCIA' in out)) {
    const pot = (isNaN(ENERGIA)) ? NaN : (ENERGIA * 1.2) / (4.2 * 30 * 0.81);
    out.POTENCIA = isNaN(pot) ? '' : (Math.round(pot * 100) / 100).toString();
  }

  const POTENCIA = num(out.POTENCIA);

  if (!('PANELES' in out)) {
    const p = isNaN(POTENCIA) ? NaN : Math.ceil((POTENCIA * 1000) / 645);
    out.PANELES = isNaN(p) ? '' : String(p);
  }

  if (!('INVERSORES' in out)) {
    const inv = isNaN(POTENCIA) ? NaN : Math.ceil(POTENCIA / 1.25);
    out.INVERSORES = isNaN(inv) ? '' : String(inv);
  }

  if (!('INVERSION_TOTAL' in out)) {
    const invTot = isNaN(POTENCIA) ? NaN : POTENCIA * 3550000;
    out.INVERSION_TOTAL = isNaN(invTot) ? '' : String(Math.round(invTot));
  }

  const INVERSION_TOTAL = num(out.INVERSION_TOTAL);

  if (!('BENEFICIO_TRIBUTARIO' in out)) {
    const ben = isNaN(INVERSION_TOTAL) ? NaN : INVERSION_TOTAL / 2;
    out.BENEFICIO_TRIBUTARIO = isNaN(ben) ? '' : String(Math.round(ben));
  }

  if (!('TIR' in out)) {
    const tir = 0.19 / 3;
    out.TIR = (tir * 100).toFixed(2) + '%';
  }

  if (!('BC' in out)) {
    out.BC = (5 / 2).toString();
  }

  if (!('AHORRO_TOTAL' in out)) {
    const ah = 250000000 / 3;
    out.AHORRO_TOTAL = String(Math.round(ah));
  }

  if (!('RECUPERACION_INVERSION' in out)) {
    out.RECUPERACION_INVERSION = (6 / 2).toString();
  }

  if (!('ENERGIA' in out) && !isNaN(ENERGIA)) out.ENERGIA = String(ENERGIA);
  if (!('FACTURA' in out) && !isNaN(FACTURA)) out.FACTURA = String(FACTURA);

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
      AHORRO_MENSUAL: data.AHORRO_MENSUAL || '',
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
