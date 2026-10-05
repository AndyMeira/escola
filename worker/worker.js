// Escola de Intercessão — Cloudflare Worker (código-fonte oficial)
// Zero dependências. Banco: D1 `escola-db` (binding DB).
// Secrets (dashboard > Settings > Variables): GEMINI_API_KEY, JWT_SECRET
// Vars (texto): GEMINI_MODEL (opcional, padrão abaixo)

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
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

// ---------- SHA-256 hex (tokens de reset) ----------
async function sha256hex(s) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return hex(new Uint8Array(bits));
}

// ---------- E-mail de reset (Resend; opcional) ----------
// Configure: wrangler secret put RESEND_API_KEY  (+ var RESEND_FROM com domínio verificado)
// Sem a chave, /auth/forgot responde ok mas não envia (sem vazar se o e-mail existe).
async function sendResetEmail(env, toEmail, name, link) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'Escola de Intercessão <nao-responda@localhost>',
        to: [toEmail],
        subject: 'Recuperação de senha — Escola de Intercessão',
        html: `<p>Olá, ${escapeHtmlLite(name)}!</p><p>Para criar uma nova senha, abra o link abaixo (válido por 1 hora):</p><p><a href="${link}">${link}</a></p><p>Se não foi você, ignore este e-mail. 🙏</p>`,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
function escapeHtmlLite(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  // Contador global do dia (monitor de cota) — nunca bloqueia a requisição
  try {
    await env.DB.prepare(
      "INSERT INTO usage_daily (day, calls) VALUES (date('now'), 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1"
    ).run();
  } catch (e) {}
  let payload;
  try {
    payload = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const model = payload.model || env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!env.GEMINI_API_KEY) return err('GEMINI_API_KEY não configurada no Worker.', 500);
  try {
    // Streaming (SSE): repassa o fluxo do Gemini direto ao navegador, sem buffer
    if (payload.stream) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${env.GEMINI_API_KEY}&alt=sse`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.body || {}) }
      );
      if (!r.ok) return json(await r.json(), r.status);
      return new Response(r.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
      });
    }
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

async function handleForgot(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  if (!rateOk('forgot:' + ip)) return err('Muitas tentativas. Aguarde 1 minuto.', 429);
  let b;
  try {
    b = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const email = (b.email || '').trim();
  // Resposta sempre igual (não revela se o e-mail existe)
  if (email) {
    const u = await findUser(env, email);
    if (u) {
      const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
      const now = new Date();
      const exp = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        'INSERT INTO password_resets (id, user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)'
      ).bind(crypto.randomUUID(), u.id, await sha256hex(raw), exp, now.toISOString()).run();
      const link = 'https://andymeira.github.io/escola/#reset=' + raw;
      await sendResetEmail(env, u.email, u.display_name || u.email, link);
    }
  }
  return json({ ok: true });
}

async function handleReset(req, env) {
  let b;
  try {
    b = await req.json();
  } catch {
    return err('Body JSON inválido.');
  }
  const token = b.token || '';
  const password = b.password || '';
  if (!token || !password) return err('Token e nova senha são obrigatórios.');
  if (password.length < 6) return err('A nova senha deve ter ao menos 6 caracteres.');

  const row = await env.DB.prepare(
    'SELECT * FROM password_resets WHERE token_hash = ? AND used = 0'
  ).bind(await sha256hex(token)).first();
  if (!row || row.expires_at < new Date().toISOString()) {
    return err('Link inválido ou expirado. Peça um novo link de recuperação.', 400);
  }
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(password), row.user_id).run();
  await env.DB.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
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
    if (path === '/auth/forgot' && req.method === 'POST') return handleForgot(req, env);
    if (path === '/auth/reset' && req.method === 'POST') return handleReset(req, env);

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
    if (path === '/db/quiz_stats' && req.method === 'GET') {
      const t = await env.DB.prepare(
        'SELECT COUNT(*) AS total, COALESCE(SUM(correct), 0) AS correct FROM quiz_attempts WHERE user_id = ?'
      ).bind(user.id).first();
      const by = await env.DB.prepare(
        'SELECT topic, COUNT(*) AS total, COALESCE(SUM(correct), 0) AS correct FROM quiz_attempts WHERE user_id = ? GROUP BY topic ORDER BY total DESC'
      ).bind(user.id).all();
      return json({ total: t.total || 0, correct: t.correct || 0, byTopic: by.results || [] });
    }
    if (path === '/db/quiz_cache' && req.method === 'POST') {
      let b;
      try {
        b = await req.json();
      } catch {
        return err('Body JSON inválido.');
      }
      if (!b || typeof b.pergunta !== 'string' || !Array.isArray(b.opcoes) || b.opcoes.length < 2 ||
          !Number.isInteger(b.correta) || b.correta < 0 || b.correta >= b.opcoes.length ||
          typeof b.topic !== 'string' || !b.topic) {
        return err('Quiz em formato inválido.');
      }
      await env.DB.prepare(
        'INSERT INTO quiz_cache (id, topic, pergunta, opcoes, correta, explicacao, versiculo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), b.topic, b.pergunta, JSON.stringify(b.opcoes), b.correta,
        b.explicacao || '', b.versiculo || '', new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/db/quiz_cache' && req.method === 'GET') {
      const topic = url.searchParams.get('topic') || '';
      const row = await env.DB.prepare(
        'SELECT pergunta, opcoes, correta, explicacao, versiculo FROM quiz_cache WHERE topic = ? ORDER BY RANDOM() LIMIT 1'
      ).bind(topic).first();
      if (!row) return err('Sem perguntas guardadas para este tema.', 404);
      let opcoes;
      try {
        opcoes = JSON.parse(row.opcoes);
      } catch {
        return err('Reserva corrompida.', 500);
      }
      return json({
        pergunta: row.pergunta, opcoes,
        correta: row.correta, explicacao: row.explicacao || '', versiculo: row.versiculo || '',
        daReserva: true,
      });
    }
    if (path === '/db/trail' && req.method === 'GET') {
      const lp = await env.DB.prepare(
        'SELECT level, lesson, MAX(created_at) AS done_at FROM lesson_progress WHERE user_id = ? GROUP BY level, lesson'
      ).bind(user.id).all();
      const la = await env.DB.prepare(
        'SELECT level, MAX(score) AS best, MAX(passed) AS passed FROM level_attempts WHERE user_id = ? GROUP BY level'
      ).bind(user.id).all();
      return json({ lessons: (lp.results || []).map(r => ({ level: r.level, lesson: r.lesson, done_at: r.done_at })), levels: la.results || [] });
    }
    if (path === '/db/lesson_progress' && req.method === 'POST') {
      let b;
      try {
        b = await req.json();
      } catch {
        return err('Body JSON inválido.');
      }
      if (!b.level || !b.lesson) return err('level e lesson são obrigatórios.');
      await env.DB.prepare(
        'INSERT INTO lesson_progress (id, user_id, level, lesson, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, level, lesson) DO NOTHING'
      ).bind(crypto.randomUUID(), user.id, String(b.level), String(b.lesson), new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/db/level_attempts' && req.method === 'POST') {
      let b;
      try {
        b = await req.json();
      } catch {
        return err('Body JSON inválido.');
      }
      const score = Number(b.score) | 0, total = Number(b.total) | 0;
      if (!b.level || !total) return err('level, score e total são obrigatórios.');
      await env.DB.prepare(
        'INSERT INTO level_attempts (id, user_id, level, score, total, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), user.id, String(b.level), score, total, (b.passed ? 1 : 0), new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (path === '/api/gemini' && req.method === 'POST') return handleGemini(req, env, user);

    return err('Rota não encontrada.', 404);
  },
};
