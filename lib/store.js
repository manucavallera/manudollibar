// Persistencia simple en JSON sobre volumen. Guarda token TN + pedidos procesados.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = join(DATA_DIR, 'state.json');

function load() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) return { token: null, storeId: null, processedOrders: [] };
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { token: null, storeId: null, processedOrders: [] };
  }
}

let state = load();

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function getToken() {
  // env gana si esta seteado (Easypanel), sino el guardado por OAuth
  return process.env.TN_ACCESS_TOKEN || state.token;
}

export function getStoreId() {
  return process.env.TN_STORE_ID || state.storeId;
}

export function saveAuth(token, storeId) {
  state.token = token;
  state.storeId = String(storeId);
  persist();
}

export function isOrderProcessed(orderId) {
  return state.processedOrders.includes(String(orderId));
}

export function markOrderProcessed(orderId) {
  const id = String(orderId);
  if (!state.processedOrders.includes(id)) {
    state.processedOrders.push(id);
    // cap para no crecer infinito
    if (state.processedOrders.length > 5000) state.processedOrders.shift();
    persist();
  }
}
