// Cliente API Tienda Nube. OJO: TN usa header "Authentication: bearer", NO "Authorization".
import { getToken, getStoreId } from './store.js';

const API = 'https://api.tiendanube.com/v1';
const UA = `dolibarr-sync (${process.env.TN_CONTACT_EMAIL || 'noemail'})`;

async function tn(path, opts = {}) {
  const storeId = getStoreId();
  const token = getToken();
  if (!storeId || !token) throw new Error('TN no autorizado todavia (falta token/storeId)');

  const res = await fetch(`${API}/${storeId}${path}`, {
    ...opts,
    headers: {
      'Authentication': `bearer ${token}`,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TN ${opts.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Intercambia el code de OAuth por access_token (endpoint distinto, no lleva storeId)
export async function exchangeCode(code) {
  const res = await fetch('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.TN_APP_ID,
      client_secret: process.env.TN_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!res.ok) throw new Error(`OAuth token -> ${res.status}: ${await res.text()}`);
  return res.json(); // { access_token, user_id, scope, token_type }
}

export async function getOrder(orderId) {
  return tn(`/orders/${orderId}`);
}

// Busca producto + variante por SKU. Devuelve {productId, variantId, stock} o null.
export async function findVariantBySku(sku) {
  const products = await tn(`/products?q=${encodeURIComponent(sku)}`);
  for (const p of products) {
    for (const v of p.variants || []) {
      if (v.sku && String(v.sku).trim() === String(sku).trim()) {
        return { productId: p.id, variantId: v.id, stock: v.stock };
      }
    }
  }
  return null;
}

export async function setVariantStock(productId, variantId, stock) {
  return tn(`/products/${productId}/variants/${variantId}`, {
    method: 'PUT',
    body: JSON.stringify({ stock }),
  });
}
