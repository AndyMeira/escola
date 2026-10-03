// Worker `escola-backup` — backup semanal do D1 `escola-db` para KV.
// Cron: todo domingo às 03:00 UTC. Mantém os 8 backups mais recentes.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(doBackup(env));
  },
  async fetch() {
    return Response.json({ ok: true, service: 'escola-backup' });
  },
};

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

  // Poda: mantém os 8 mais recentes
  const list = await env.BACKUPS.list({ prefix: 'backup-' });
  const keys = list.keys.map(k => k.name).sort();
  while (keys.length > 8) {
    await env.BACKUPS.delete(keys.shift());
  }
  return { ok: true, key };
}
