// Cliente API REST Dolibarr. Auth via header DOLAPIKEY.
const BASE = `${process.env.DOLI_URL}/api/index.php`;
const KEY = process.env.DOLI_API_KEY;

async function doli(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'DOLAPIKEY': KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dolibarr ${opts.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Producto por Ref (= SKU de TN). Devuelve objeto producto o null.
export async function getProductByRef(ref) {
  try {
    return await doli(`/products/ref/${encodeURIComponent(ref)}`);
  } catch (e) {
    if (String(e.message).includes('-> 404')) return null;
    throw e;
  }
}

// Stock real actual de un producto.
export async function getStock(productId) {
  const p = await doli(`/products/${productId}`);
  return Number(p.stock_reel ?? 0);
}

// Producto por id. Devuelve {ref, stock_reel} o null.
export async function getProductById(productId) {
  try {
    return await doli(`/products/${productId}`);
  } catch (e) {
    if (String(e.message).includes('-> 404')) return null;
    throw e;
  }
}

// Crea factura con lineas. lines: [{product_id, qty, subprice}]
export async function createInvoice(socid, lines, refExt) {
  const id = await doli('/invoices', {
    method: 'POST',
    body: JSON.stringify({
      socid,
      ref_ext: refExt, // "TN-<orderId>" para trazabilidad/idempotencia
      type: 0,
      lines: lines.map((l) => ({
        fk_product: l.product_id,
        qty: l.qty,
        subprice: l.subprice,
        tva_tx: l.tva_tx ?? 0,
      })),
    }),
  });
  return id; // Dolibarr devuelve el id (numero)
}

// Valida factura -> descuenta stock automatico (modulo Stock activo).
export async function validateInvoice(invoiceId) {
  return doli(`/invoices/${invoiceId}/validate`, { method: 'POST', body: JSON.stringify({}) });
}

// Registra pago total. Marca factura como pagada.
export async function payInvoice(invoiceId, amount, bankAccountId) {
  return doli(`/invoices/${invoiceId}/payments`, {
    method: 'POST',
    body: JSON.stringify({
      datepaye: Math.floor(Date.now() / 1000),
      paymentid: 1, // forma de pago generica
      closepaidinvoices: 'yes',
      accountid: bankAccountId || 1,
      amounts: { [invoiceId]: amount },
    }),
  });
}

// Lista todos los productos (ref + stock_reel), paginado.
export async function listAllProducts() {
  const out = [];
  let page = 0;
  const limit = 100;
  for (;;) {
    const batch = await doli(`/products?limit=${limit}&page=${page}&sortfield=t.rowid&sortorder=ASC`);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const p of batch) {
      if (p.ref) out.push({ ref: p.ref, stock: Number(p.stock_reel ?? 0) });
    }
    if (batch.length < limit) break;
    page++;
  }
  return out;
}

// Busca factura existente por ref_ext (idempotencia backup).
export async function findInvoiceByRefExt(refExt) {
  try {
    const list = await doli(`/invoices?sqlfilters=${encodeURIComponent(`(t.ref_ext:=:'${refExt}')`)}`);
    return Array.isArray(list) && list.length ? list[0] : null;
  } catch (e) {
    if (String(e.message).includes('-> 404')) return null;
    throw e;
  }
}
