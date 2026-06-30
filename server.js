import express from 'express';
import crypto from 'crypto';
import { exchangeCode, getOrder, findVariantBySku, setVariantStock, registerWebhook } from './lib/tiendanube.js';
import * as doli from './lib/dolibarr.js';
import { saveAuth, isOrderProcessed, markOrderProcessed } from './lib/store.js';

const app = express();
app.set('trust proxy', 1);
// Guardamos el body crudo para verificar HMAC de TN.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || 3000;
const DEFAULT_SOCID = Number(process.env.DOLI_SOCID);
const BANK = process.env.DOLI_BANK_ACCOUNT;

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- OAuth callback: TN redirige aca con ?code= tras instalar la app ----
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta code');
  try {
    const data = await exchangeCode(code);
    saveAuth(data.access_token, data.user_id);
    console.log(`[oauth] autorizado store ${data.user_id}, scopes: ${data.scope}`);

    const callbackUrl = `${req.protocol}://${req.get('host')}/webhook/tn/order`;
    try {
      await registerWebhook('order/paid', callbackUrl);
      console.log(`[oauth] webhook order/paid registrado -> ${callbackUrl}`);
    } catch (e) {
      console.error('[oauth] no se pudo registrar webhook:', e.message);
    }

    res.send('App conectada OK. Token guardado. Ya podes cerrar esta pestaña.');
  } catch (e) {
    console.error('[oauth]', e.message);
    res.status(500).send('Error al autorizar: ' + e.message);
  }
});

// Verifica firma HMAC del webhook TN (header x-linkedstore-hmac-sha256).
function verifyTnHmac(req) {
  const secret = process.env.TN_CLIENT_SECRET;
  const sig = req.get('x-linkedstore-hmac-sha256');
  if (!secret || !sig) return false;
  const calc = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---- FLUJO A: venta online TN -> factura + pago + stock en Dolibarr ----
app.post('/webhook/tn/order', async (req, res) => {
  if (!verifyTnHmac(req)) return res.status(401).send('firma invalida');
  res.sendStatus(200); // responder rapido; procesar async

  const orderId = req.body.id;
  try {
    if (isOrderProcessed(orderId)) { console.log(`[A] order ${orderId} ya procesada, skip`); return; }

    const order = await getOrder(orderId); // datos completos
    const refExt = `TN-${orderId}`;

    // idempotencia backup: si ya existe la factura, marcar y salir
    if (await doli.findInvoiceByRefExt(refExt)) { markOrderProcessed(orderId); return; }

    // armar lineas mapeando SKU -> producto Dolibarr
    const lines = [];
    for (const it of order.products) {
      if (!it.sku) { console.warn(`[A] item sin SKU en order ${orderId}, skip linea`); continue; }
      const prod = await doli.getProductByRef(it.sku);
      if (!prod) { console.warn(`[A] SKU ${it.sku} no existe en Dolibarr, skip linea`); continue; }
      lines.push({ product_id: prod.id, qty: Number(it.quantity), subprice: Number(it.price) });
    }
    if (!lines.length) { console.warn(`[A] order ${orderId} sin lineas validas`); return; }

    const invId = await doli.createInvoice(DEFAULT_SOCID, lines, refExt);
    await doli.validateInvoice(invId);      // descuenta stock
    const total = lines.reduce((s, l) => s + l.qty * l.subprice, 0);
    await doli.payInvoice(invId, total, BANK); // marca pagada
    markOrderProcessed(orderId);
    console.log(`[A] order ${orderId} -> factura ${invId} validada y pagada`);
  } catch (e) {
    console.error(`[A] order ${orderId} ERROR:`, e.message);
  }
});

// ---- FLUJO B: cambio de stock en Dolibarr -> push a TN ----
// Dolibarr (modulo Webhook) postea aca. Anti-loop: comparar antes de pushear.
app.post('/webhook/doli/stock', async (req, res) => {
  res.sendStatus(200);
  console.log('[B] payload recibido:', JSON.stringify(req.body));
  try {
    // El payload de Dolibarr varia segun trigger; intentamos sacar ref + stock.
    const ref = req.body.ref || req.body.product_ref;
    if (!ref) { console.warn('[B] webhook sin ref'); return; }

    const prod = await doli.getProductByRef(ref);
    if (!prod) { console.warn(`[B] ref ${ref} no esta en Dolibarr`); return; }
    const doliStock = await doli.getStock(prod.id);

    const v = await findVariantBySku(ref);
    if (!v) { console.warn(`[B] SKU ${ref} no existe en TN`); return; }

    if (Number(v.stock) === Number(doliStock)) {
      console.log(`[B] ref ${ref} ya en ${doliStock}, no push (corta loop)`);
      return;
    }
    await setVariantStock(v.productId, v.variantId, doliStock);
    console.log(`[B] ref ${ref}: TN ${v.stock} -> ${doliStock}`);
  } catch (e) {
    console.error('[B] ERROR:', e.message);
  }
});

app.listen(PORT, () => console.log(`connector escuchando en :${PORT}`));
