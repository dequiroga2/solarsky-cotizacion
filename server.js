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

// ----------------- Fórmulas (Ahora solo Helpers de Formato) -----------------
function toNum(v) {
  if (v === undefined || v === null || v === '') return NaN;
  const n = Number(String(v).toString().replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? NaN : n;
}

/**
 * Formato miles Colombia (Redondea a entero)
 * Ej: 11640211.64 -> "11.640.212"
 */
function formatCO(v) {
  const n = toNum(v);
  if (isNaN(n)) return '';
  // Redondea al entero más cercano
  return Math.round(n).toLocaleString('es-CO');
}

/**
 * Formato decimales Colombia
 * Ej: 3.88007 -> "3,88"
 */
function formatDecimal(v, digits = 2) {
  const n = toNum(v);
  if (isNaN(n)) return '';
  return n.toLocaleString('es-CO', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

/**
 * Formato porcentaje Colombia
 * Ej: 0.3759 -> "37,59%"
 */
function formatPercent(v, digits = 2) {
  const n = toNum(v);
  if (isNaN(n)) return '';
  // El valor ya es un decimal (0.37), se multiplica por 100
  return (n * 100).toLocaleString('es-CO', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }) + '%';
}


// ----------------- Fórmulas (Versión Simplificada) -----------------
function computeFields(input = {}) {
  // 1. Preservar todos los campos de entrada (EMPRESA, CLIENTE, CIUDAD, etc.)
  const out = { ...input };
  
  // 2. Obtener el objeto de resultados que viene del Google Sheet
  const resultados = input.resultados || {};

  // 3. Mapear y formatear los valores del JSON
  // (Según tu lista)
  
  // 1. Potencia
  out.POTENCIA = formatDecimal(resultados["PROYECTO!E6"], 2);
  
  // 2. Inversor (redondeado abajo)
  out.INVERSORES = formatCO(Math.floor(toNum(resultados["PROYECTO!E7"])));

  // 3. Inversion
  out.INVERSION_TOTAL = formatCO(resultados["PROYECTO!E17"]);
  
  // 4. Ahorro estimado 25 años
  out.AHORRO_TOTAL = formatCO(resultados["PROYECTO!E19"]);
  
  // 5. Retorno inversion
  out.RECUPERACION_INVERSION = formatDecimal(resultados["PROYECTO!E20"], 2);
  
  // 6. Beneficio tributario
  out.BENEFICIO_TRIBUTARIO = formatCO(resultados["PROYECTO!E23"]);
  
  // 7. primer pago
  out.PAGO1 = formatCO(resultados["PROYECTO!D40"]);
  
  // 8. segundo pago
  out.PAGO2 = formatCO(resultados["PROYECTO!D44"]);
  
  // 9. tercer pago
  out.PAGO3 = formatCO(resultados["PROYECTO!D49"]);
  
  // 10. cuarto pago
  out.PAGO4 = formatCO(resultados["PROYECTO!D54"]);
  
  // 11. TIR
  out.TIR = formatPercent(resultados["VPN+TIR!E55"], 2);
  
  // 4. Formatear campos que vienen de la entrada (no de 'resultados')
  out.ENERGIA = formatCO(out.ENERGIA);
  out.FACTURA = formatCO(out.FACTURA);
  out.PANELES = formatCO(resultados["PROYECTO!F6"]); // Si PANELES viene de la entrada

  // 5. Asignar valores por defecto a campos ya no calculados
  out.BC = out.BC || ''; // BC ya no se calcula
  out.IVA_MATERIALES = out.IVA_MATERIALES || ''; // IVA ya no se calcula

  // 6. Asignar fecha si no viene
  if (!out.FECHA) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Bogota' };
    out.FECHA = new Date().toLocaleDateString('es-CO', options);
  }
  
  return out;
}


// ----------------- Endpoint principal -----------------
app.post('/render/cotizacion', async (req, res) => {
  try {
    // Asumimos que n8n envía todo en req.body.data
    // ej: { "data": { "EMPRESA": "...", "resultados": { ... } } }
    const inputData = req.body?.data || {};
    
    // La nueva función 'computeFields' solo formatea y mapea
    const data = computeFields(inputData);

    const urlIndex  = buildPageUrl(req, 'index.html', {
      EMPRESA: data.EMPRESA,
      CLIENTE: data.CLIENTE,
      CIUDAD: data.CIUDAD,
      FECHA: data.FECHA,
      POTENCIA: data.POTENCIA, // Formateado
      ENERGIA: data.ENERGIA,   // Formateado
      FACTURA: data.FACTURA    // Formateado
    });

    const urlIndex2 = buildPageUrl(req, 'index2.html', {
      PANELES: data.PANELES,   // Formateado (si se pasó)
      INVERSORES: data.INVERSORES // Formateado
    });

    const urlIndex3 = buildPageUrl(req, 'index3.html', {
      // Datos formateados de 'resultados'
      INVERSION_TOTAL: data.INVERSION_TOTAL,
      BENEFICIO_TRIBUTARIO: data.BENEFICIO_TRIBUTARIO,
      RECUPERACION_INVERSION: data.RECUPERACION_INVERSION,
      TIR: data.TIR,
      AHORRO_TOTAL: data.AHORRO_TOTAL,
      PAGO1: data.PAGO1,
      PAGO2: data.PAGO2,
      PAGO3: data.PAGO3,
      PAGO4: data.PAGO4,
      
      // Datos de entrada formateados
      ENERGIA: data.ENERGIA,
      FACTURA: data.FACTURA,
      
      // Datos residuales (usados por el template)
      AHORRO_MENSUAL: data.AHORRO_TOTAL || '', // El template usa AHORRO_TOTAL aquí
      BC: data.BC || '', // Vacío
      IVA_MATERIALES: data.IVA_MATERIALES || '' // Vacío
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