[README.md](https://github.com/user-attachments/files/34434698/README.md)
# checktour-portal (unificado)

Um único Worker com o portal + as 3 checklists:

| Caminho | Projeto |
|---|---|
| `/` | Portal (atalhos + ETA) |
| `/up/` | Check List Tour — Upholstery (antigo checktourup) |
| `/bo/` | Check List Tour — Board (antigo checktourbo) |
| `/dux/` | Check List — DUX (antigo dux-scan) |

Admin continua igual: acrescente `?admin=1` (ex.: `/?admin=1`, `/up/?admin=1`).
No portal em modo admin os atalhos já abrem cada checklist com `?admin=1`.

## Estrutura
```
wrangler.jsonc         config (mesmo RESEND_API_KEY / REPORT_RECIPIENTS dos projetos antigos)
src/index.js           Worker + ChecklistState (3 instâncias: up/bo/dux) + PortalState (ETA)
dist/index.html        portal
dist/up/index.html     Upholstery
dist/bo/index.html     Board
dist/dux/index.html    DUX
```

## Deploy
1. Suba esta pasta num repositório novo do GitHub.
2. Cloudflare → Workers & Pages → Create → Import a repository → selecione o repo → Deploy.
   O secret `resend-api-key` do Secrets Store já é usado pelos projetos antigos, então funciona direto.
3. Abra `/?admin=1`, entre em cada projeto e suba a planilha de novo (os dados antigos ficam nos Workers antigos).
4. Quando tudo estiver ok, apague os Workers antigos (checktourup, checktourbo, dux-scan).

## Mudanças em relação aos projetos antigos
- Chamadas de API agora usam o prefixo do projeto (`/up/api/...`, `/bo/api/...`, `/dux/api/...`).
- Cada checklist tem um link "← All projects" que volta para o portal (mantém `?admin=1`).
- E-mail por projeto: assunto e nome do CSV identificam Upholstery / Board / DUX.
- Corrigido bug da rota `/note` do Upholstery/Board (variável `isComplete` inexistente → erro 500).
