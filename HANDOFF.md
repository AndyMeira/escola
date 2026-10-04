# Escola de Intercessão — Documento de Continuidade
> Última atualização: 04/10/2026. Cole este arquivo inteiro numa nova conversa
> para retomar o projeto exatamente de onde parou.

## 1. O que é
Site de estudo bíblico sobre intercessão cristã ("Escola de Intercessão"):
chat com IA + quiz gerado por IA + aba de intercessores + progresso + PWA instalável.
Fundamento sempre bíblico primeiro (versão NAA em PT); pastores/intercessores
são citados só como testemunho. Dono: Anderson (GitHub: AndyMeira).

## 2. Arquitetura atual (100% gratuita)
| Parte | Onde | Detalhe |
|---|---|---|
| Frontend + PWA | GitHub `AndyMeira/escola`, branch `main` | `index.html` (single-file), `manifest.json` (`/escola/`), `sw.js` (cache v4), `icon-192/512.png`. Ao vivo: https://andymeira.github.io/escola/ |
| Backend (auth + proxy Gemini + banco) | Cloudflare Worker `escola-intercessao-api` | Fonte versionada em `worker/` no repo (`worker.js` zero-dep, `wrangler.toml`, `README.md`). D1 `escola-db` (binding `DB`, id `bebda047-...`). Secrets: `GEMINI_API_KEY`, `JWT_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`. |
| Backup + monitor | Worker `escola-backup` | Fonte em `worker-backup/`. Cron dom 03h (backup D1→KV `escola_kv_backups`, id `925fd76d...`, mantém 8) + diário 21h (alerta cota ≥1200 e resumo semanal por e-mail). Secrets: `RESEND_API_KEY`, `OWNER_EMAIL`, `RESEND_FROM`. |
| Banco velho (INATIVO) | Supabase `xmlspowbfzbptldtferl` | Tabelas vazias; Worker não usa. Manter ou desligar (item pendente). |

## 3. Esquema D1 (`escola-db`)
- `users(id, email UNIQUE, password_hash, display_name, created_at)` — hash: `salHex:hashHex` = **PBKDF2-SHA256, 100k iterações, sal 16 bytes** (verificado por engenharia reversa).
- `chat_messages(id, user_id, role, content, created_at)` (ISO UTC).
- `quiz_attempts(id, user_id, topic, question, correct INTEGER 0/1, created_at)`.
- `password_resets(id, user_id, token_hash=sha256(token), expires_at, used, created_at)` — token 1h.
- `quiz_cache(id, topic, pergunta, opcoes JSON, correta, explicacao, versiculo, created_at)` — reserva offline da IA.
- `usage_daily(day, calls)` — contador global p/ monitor de cota.

## 4. Auth/JWT
JWT próprio HS256 (`JWT_SECRET`), payload `{sub, email, iat, exp}`, expiração **7 dias**.
Rotas: `POST /api/gemini` (auth; `stream:true` → SSE; limite 75/dia/usuário + 30 req/min/IP),
`POST /auth/signup|/auth/login|/auth/forgot|/auth/reset`, `GET /auth/session`,
`GET /db/profile`, `GET|POST /db/chat_messages`, `POST /db/quiz_attempts`,
`GET /db/quiz_stats`, `GET|POST /db/quiz_cache`, `GET /db/usage`.

## 5. Modelo IA e blindagens
- Modelo: `gemini-3.6-flash` (1.5/2.x foram aposentados pelo Google; 3.8 dá 503 frequente).
- Chat com **streaming SSE**; retry automático 3s/6s/9s em 503; erros traduzidos (`friendlyError`).
- Quiz salva cada pergunta na reserva (`quiz_cache`); se a IA cai, serve pergunta guardada (badge "📦 pergunta guardada").
- Frontend valida quiz (`isValidQuiz`), embaralha opções (referência, não texto), teto de contexto 40 msgs (`MAX_HISTORY`).

## 6. Frontend — diretrizes vigentes
- **FONTES.md** (marca): Display Almendra · Leitura EB Garamond · Interface Lato. Bloco `DIRETRIZ DE FONTES` no CSS impõe via `body ...` + `!important`.
- **Contraste canônico**: pares mutuamente exclusivos `body:not(.light)` × `body.light` (nunca regras de cor sem escopo!). Auditado via navegador: dark ≥8.28, light ≥5.03 em 23 componentes.
- **Tema claro/escuro**: botão 🌙/☀️ fixo, `localStorage ei_theme`, padrão escuro, brasas/fogo nos dois temas.
- **Responsivo**: `@media 640px/360px`, inputs 16px (sem zoom iOS), `viewport-fit=cover`, `dvh`.
- **Offline parcial**: banner 📡, histórico em `localStorage ei_history_<userId>`, quiz/chat avisam offline, fontes em cache no SW.
- **Recuperação de senha**: telas forgot/reset + `#reset=TOKEN`; e-mail via Resend (requer `RESEND_API_KEY` + domínio verificado p/ produção; modo teste só entrega no e-mail do cadastro Resend).
- Outras correções aplicadas: mojibake cp1252, `</script>` órfã, botão travado pós-reset, sessão expirada, quiz com limite diário, PWA paths `/escola/`.

## 7. Credenciais e acessos (nunca colar em chat)
- GitHub CLI (`gh`) e `wrangler` já autenticados no PC do Anderson.
- Senhas do usuário ficam só no D1 (hash). Teste sempre com usuários `@example.com` e apague depois via `wrangler d1 execute`.
- E-mail do dono p/ alertas: derson.meira@gmail.com (também usuário real no D1).

## 8. Pendências (ordem sugerida)
1. **Idioma ES/EN — FEITO (04/10/2026, commit 3ccde9b)** — `STR` PT/ES/EN + `THEME_I18N` + `TOPIC_I18N`, seletor `#langSwitch` (`ei_lang`, auto-detect), prompts localizados (`getSystemPrompt`/`getQuizPrompt`), Bíblias PT=NAA / ES=RVR1960 / EN=KJV. Tópicos D1 seguem em PT (chave estável). Cards "Os Intercessores" seguem PT (nomes próprios). SW v5.
2. **Resend produção** — verificar domínio próprio (hoje: modo teste).
3. **Supabase** — desligar ou documentar como desativado.
4. Streaming já ok; ranking já ok (aba Progresso).

## 9. Comandos úteis
```powershell
cd "C:\Users\anderson\Desktop\projeto escola intercessão\repo-escola"
git pull; git log --oneline -5
npx wrangler d1 execute escola-db --remote --command "SELECT COUNT(*) FROM users" --json
npx wrangler d1 execute escola-db --remote --command "SELECT calls FROM usage_daily WHERE day = date('now')" --json
npx wrangler deploy                  # dentro de worker/ ou worker-backup/
npx wrangler rollback [version-id]
npx wrangler d1 export escola-db --remote --output b.sql
```
Teste ponta a ponta padrão: signup `@example.com` → login → gemini → chat save/load → quiz → stats → apagar tudo do D1.
