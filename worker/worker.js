// Escola de Intercessão — Cloudflare Worker (código-fonte oficial)
// Zero dependências. Banco: D1 `escola-db` (binding DB).
// Secrets (dashboard > Settings > Variables): GEMINI_API_KEY, JWT_SECRET
// Vars (texto): GEMINI_MODEL (opcional, padrão abaixo)

const DEFAULT_MODEL = 'gemini-3.6-flash';
const DAILY_LIMIT = 75;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const JWT_DIAS = 7;

const CORS = {
  'Access-Control-Allow-Origin': 'https://andymeira.github.io',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
const err = (message, status = 400) => json({ error: { message } }, status);

// ---------- base64url ----------
function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- JWT (HS256) ----------
async function jwtSign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const head = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head + '.' + body)));
  return `${head}.${body}.${b64urlEncode(sig)}`;
}
async function jwtVerify(token, secret) {
  try {
    const [head, body, sig] = token.split('.');
    if (!head || !body || !sig) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sig), new TextEncoder().encode(head + '.' + body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
function newToken(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign({ sub: user.id, email: user.email, iat: now, exp: now + JWT_DIAS * 86400 }, secret);
}

// ---------- Senhas (PBKDF2-SHA256, 100k iterações, sal 16 bytes) ----------
function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}
async function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 100000 }, key, 256
    ));
    const want = unhex(hashHex);
    if (bits.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------- Rate limiting (por IP, aproximado) ----------
const hits = new Map();
function rateOk(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => t > now - RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  if (hits.size > 5000) hits.clear();
  hits.set(key, arr);
  return true;
}

// ---------- Banco ----------
async function findUser(env, email) {
  let u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u && email) u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
  return u;
}
function publicUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name };
}
function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
async function todayCount(env, userId) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND role = 'user' AND created_at >= ?"
  ).bind(userId, startOfTodayUTC()).first();
  return r ? r.n : 0;
}

// ---------- Handlers ----------
async function handleGemini(req, env, user) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  if (!rateOk('gemini:' + ip)) return err('Limite de requisições excedido. Aguarde 1 minuto.', 429);
  if (await todayCount(env, user.id) >= DAILY_LIMIT) {
    return err(`Você atingiu o limite de ${DAILY_LIMIT} mensagens hoje. Volte amanhã para continuar aprendendo! 🙏`, 429);
  }
  let payload;
  try {
    payload = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const model = payload.model || env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!env.GEMINI_API_KEY) return err('GEMINI_API_KEY não configurada no Worker.', 500);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.body || {}) }
    );
    return json(await r.json(), r.status);
  } catch (e) {
    return err('Falha ao chamar o Gemini: ' + e.message, 500);
  }
}

async function handleSignup(req, env) {
  let b;
  try {
    b = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const email = (b.email || '').trim();
  const password = b.password || '';
  const display_name = (b.display_name || '').trim();
  if (!email || !password) return err('E-mail e senha são obrigatórios.');
  if (!display_name) return err('Nome é obrigatório.');
  if (await findUser(env, email)) return err('Este e-mail já está cadastrado. Tente entrar.', 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, email, await hashPassword(password), display_name, now).run();

  const user = { id, email, display_name };
  return json({ user, access_token: await newToken(user, env.JWT_SECRET) });
}

async function handleLogin(req, env) {
  let b;
  try {
    b = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const email = (b.email || '').trim();
  const password = b.password || '';
  if (!email || !password) return err('E-mail e senha são obrigatórios.');
  const u = await findUser(env, email);
  if (!u || !(await verifyPassword(password, u.password_hash))) {
    return err('E-mail ou senha inválidos.', 401);
  }
  const user = publicUser(u);
  return json({ user, access_token: await newToken(user, env.JWT_SECRET) });
}

// ---------- Router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/auth/signup' && req.method === 'POST') return handleSignup(req, env);
    if (path === '/auth/login' && req.method === 'POST') return handleLogin(req, env);

    const auth = req.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const payload = token ? await jwtVerify(token, env.JWT_SECRET) : null;
    if (!payload) return err('Não autenticado. Faça login para usar o chat.', 401);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return err('Não autenticado. Faça login para usar o chat.', 401);

    if (path === '/auth/session') return json({ user: publicUser(user) });
    if (path === '/db/profile') return json({ display_name: user.display_name });

    if (path === '/db/chat_messages' && req.method === 'GET') {
      const r = await env.DB.prepare(
        'SELECT role, content, created_at FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 50'
      ).bind(user.id).all();
      return json({ messages: r.results || [] });
    }
    if (path === '/db/chat_messages' && req.method === 'POST') {
      let b;
      try {
        b = await req.json();
      } catch {
        return err('Body JSON inválido.');
      }
      if (!b.role || typeof b.content !== 'string') return err('role e content são obrigatórios.');
      await env.DB.prepare(
        'INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), user.id, b.role, b.content, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/db/quiz_attempts' && req.method === 'POST') {
      let b;
      try {
        b = await req.json();
      } catch {
        return err('Body JSON inválido.');
      }
      await env.DB.prepare(
        'INSERT INTO quiz_attempts (id, user_id, topic, question, correct, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), user.id, b.topic || null, b.question || null, b.correct ? 1 : 0, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/db/usage' && req.method === 'GET') {
      return json({ count: await todayCount(env, user.id) });
    }
    if (path === '/api/gemini' && req.method === 'POST') return handleGemini(req, env, user);

    return err('Rota não encontrada.', 404);
  },
};
