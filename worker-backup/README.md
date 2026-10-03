# Worker `escola-backup` — backup automático + monitor de cota

## Backup (D1 → KV)
Todo domingo às 03:00 UTC, copia as tabelas `users`, `chat_messages` e
`quiz_attempts` do D1 `escola-db` para o KV `escola_kv_backups`
(chave `backup-AAAA-MM-DD.json`, mantém os 8 mais recentes).

## Monitor de cota do Gemini
Todo dia às 21:00 UTC, lê o contador global `usage_daily`:
- **≥ 1200 chamadas no dia** → e-mail de alerta ⚠️
- **Domingo** → e-mail com resumo semanal 📊

### Secrets necessários (neste worker)
```bash
npx wrangler secret put RESEND_API_KEY   # mesma chave do worker principal
npx wrangler secret put OWNER_EMAIL      # ex: derson.meira@gmail.com
npx wrangler secret put RESEND_FROM      # ex: Escola de Intercessão <onboarding@resend.dev>
```
Sem esses secrets, o backup continua funcionando; só os e-mails ficam desligados.

## Deploy

```bash
cd worker-backup
npx wrangler deploy
```

## Restaurar um backup

```bash
# ver backups disponíveis
npx wrangler kv key list --remote --namespace-id=925fd76df6514bb9a6ac916fd38808b9
# baixar um backup
npx wrangler kv key get --remote --namespace-id=925fd76df6514bb9a6ac916fd38808b9 backup-AAAA-MM-DD.json > restore.json
```

## Backup manual do D1 (fora do agendamento)

```bash
npx wrangler d1 export escola-db --remote --output backup-manual.sql
```
