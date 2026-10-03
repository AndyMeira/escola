# Worker `escola-backup` — backup automático do banco

Todo domingo às 03:00 UTC, copia as tabelas `users`, `chat_messages` e
`quiz_attempts` do D1 `escola-db` para o KV `escola_kv_backups`
(chave `backup-AAAA-MM-DD.json`, mantém os 8 mais recentes).

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
