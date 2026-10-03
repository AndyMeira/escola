# Worker `escola-intercessao-api` — código-fonte oficial

Backend do site (auth + proxy Gemini + banco D1 `escola-db`).

## Arquivos

- `worker.js` — código completo (zero dependências, Web Crypto p/ senhas PBKDF2-SHA256/100k e JWT HS256)
- `wrangler.toml` — config de deploy (nome, binding D1)

## Deploy

```bash
cd worker
npx wrangler deploy
```

## Secrets (nunca commitar valores)

| Nome | Onde obter |
|------|-----------|
| `GEMINI_API_KEY` | Google AI Studio |
| `JWT_SECRET` | Gerar: `openssl rand -hex 32` |

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put JWT_SECRET
```

Variável opcional (texto): `GEMINI_MODEL` (padrão: `gemini-3.6-flash`).

## Rollback

```bash
npx wrangler rollback [version-id]   # ver IDs com: npx wrangler versions list
```

## Rotas

`POST /api/gemini` (auth, limite 75/dia/usuário + 30 req/min/IP) ·
`POST /auth/signup` · `POST /auth/login` · `GET /auth/session` ·
`GET /db/profile` · `GET|POST /db/chat_messages` ·
`POST /db/quiz_attempts` · `GET /db/usage`
