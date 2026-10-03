# Diretriz de Fontes — marca da Escola de Intercessão

> A fonte é identidade. Nenhum texto novo entra no projeto fora destas 3 famílias.
> A regra que impõe isso está no final do `<style>` em `index.html`
> (bloco `DIRETRIZ DE FONTES`), com seletores `body ...` + `!important`
> para vencer qualquer herança ou tema.

## As 3 famílias

| Papel | Fonte | Onde |
|-------|-------|------|
| **Display** | Almendra (400/700, normal + itálico) | `header h1`, `auth h2`, botões principais (Entrar, Gerar Pergunta), títulos de pergunta do quiz, nomes dos intercessores, etiquetas das mensagens |
| **Leitura** | EB Garamond (400/500, normal + itálico) | Bolhas do chat, explicações do quiz, versículos, subtítulos/itálicos de apoio, textos dos cards de intercessores, "carregando..." |
| **Interface** | Lato (300/400/700) | Abas, chips de tema, nomes/subtítulos dos cards do quiz, inputs, botões secundários, selos, barra do usuário, avisos, progresso |

## Regras

1. **Nunca** usar outra família (nada de Arial, Times, system-ui) em texto visível.
2. **Nada de Playfair Display ou Cinzel Decorative** — foram removidas do projeto (o Google Fonts carrega só Almendra + EB Garamond + Lato).
3. Itálico é permitido como ênfase dentro de Leitura (versículos, citações) e nos subtítulos dos cards.
4. Tamanho mínimo de texto funcional: **12px** (11px só em etiquetas UPPERCASE com tracking).
5. Inputs em mobile mantêm **16px** (evita o zoom automático do iOS).
6. Ao criar um componente novo, escolha 1 dos 3 papéis acima e siga a tabela.
