// Worker `escola-backup` — backup do D1 + monitor de cota do Gemini.
// - Domingo 03:00 UTC: backup completo + resumo semanal por e-mail.
// - Todo dia 21:00 UTC: verifica consumo; alerta se passar de 80% da cota.
// E-mails exigem os secrets RESEND_API_KEY, OWNER_EMAIL e RESEND_FROM
// neste worker (sem eles, só o backup em KV funciona).
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rotina(env));
  },
  async fetch() {
    return Response.json({ ok: true, service: 'escola-backup' });
  },
};

async function rotina(env) {
  const backup = await doBackup(env);
  const email = await verificarCota(env);
  return { backup, email };
}

async function doBackup(env) {
  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const users = await env.DB.prepare('SELECT * FROM users').all();
  const msgs = await env.DB.prepare('SELECT * FROM chat_messages').all();
  const quiz = await env.DB.prepare('SELECT * FROM quiz_attempts').all();

  const key = `backup-${day}.json`;
  await env.BACKUPS.put(key, JSON.stringify({
    at, users: users.results || [], chat_messages: msgs.results || [], quiz_attempts: quiz.results || [],
  }));

  const list = await env.BACKUPS.list({ prefix: 'backup-' });
  const keys = list.keys.map(k => k.name).sort();
  while (keys.length > 8) {
    await env.BACKUPS.delete(keys.shift());
  }
  return { ok: true, key };
}

async function verificarCota(env) {
  if (!env.RESEND_API_KEY || !env.OWNER_EMAIL) return { ok: false, motivo: 'sem-secrets' };
  const hoje = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare('SELECT calls FROM usage_daily WHERE day = ?').bind(hoje).first();
  const calls = row ? row.calls : 0;
  const LIMITE_ALERTA = 1200;
  const domingo = new Date().getUTCDay() === 0;

  let assunto = null, texto = null;
  if (calls >= LIMITE_ALERTA) {
    assunto = `⚠️ Cota do Gemini em ${Math.round((calls / 1500) * 100)}% hoje (${calls} chamadas)`;
    texto = `O consumo de hoje já está em ${calls} chamadas à IA. Se passar de ~1500, o chat para até virar o dia. Considere avisar os usuários ou aguardar.`;
  } else if (domingo) {
    const semana = await env.DB.prepare(
      "SELECT COALESCE(SUM(calls), 0) AS total FROM usage_daily WHERE day >= date('now', '-7 days')"
    ).first();
    assunto = `📊 Resumo semanal — Escola de Intercessão (${semana.total} chamadas à IA)`;
    texto = `Hoje: ${calls} chamadas. Últimos 7 dias: ${semana.total} chamadas. Pico diário considerado seguro: abaixo de 1200.`;
  }
  if (!assunto) return { ok: true, acao: 'sem-envio' };

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'Escola de Intercessão <onboarding@resend.dev>',
        to: [env.OWNER_EMAIL],
        subject: assunto,
        text: texto,
      }),
    });
    return { ok: r.ok, acao: r.ok ? 'enviado' : 'falha-resend' };
  } catch (e) {
    return { ok: false, acao: 'erro-rede' };
  }
}
