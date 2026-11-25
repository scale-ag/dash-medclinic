# Implantação real: passos PENDENTES

Nada abaixo foi executado por este PR. Compilar e passar nos testes **não** significa que o dashboard
está no ar. Os testes usam apenas uma API Meta falsa em memória e dados sintéticos isolados.

## 1. Configuração do repositório (feita por quem administra)

Em *Settings → Secrets and variables → Actions*:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `META_ACCESS_TOKEN` | Token com **apenas** `ads_read` nas contas CA01/CA02. Nada de escrita. Não reutilize tokens de outros projetos. |
| Variable | `META_APP_ID` | ID do app do token. O coletor confere via `GET /app`. |
| Variable | `META_API_VERSION` | Opcional. O padrão é `v25.0`. A versão efetiva observada foi `v27.0`. |
| Variable | `DATA_START` | Opcional. O padrão é `2026-11-01`. |
| Variable | `PUBLIC_DATA_APPROVED` | Deixe **sem valor** ou `false` até a aprovação final. Só `true` libera a publicação. |

O Pages já está com *Source = GitHub Actions*. O ambiente `github-pages` deve aceitar deploy só da
`main`, que é o padrão.

## 2. Validação real ANTES da aprovação

Primeiro, local, na sua máquina. O token fica só no seu terminal e os dados ficam em `.work/` e `dist/`,
que são ignorados pelo git. Coleta:

```bash
META_ACCESS_TOKEN=... META_APP_ID=... npm run collect -- --out .work/snapshot.json
```

Build:

```bash
npm run build -- --snapshot .work/snapshot.json --out dist
```

Validação:

```bash
npm run validate -- --dist dist
```

Abra o preview em http://localhost:8787/dash-medclinic/ e compare com o Gerenciador de Anúncios:

```bash
npm run preview
```

No Actions, rode *Deploy dashboard → Run workflow*. Com o secret cadastrado e `PUBLIC_DATA_APPROVED`
ainda diferente de `true`, a execução testa, coleta, monta e valida. Depois ela **falha de propósito no
portão de publicação**, sem enviar nada ao Pages. Os logs mostram só contagens e coberturas, porque o
repositório é público.

### Checklist de conciliação com a UI da Meta

Mesmo período, mesma atribuição do conjunto, fuso de São Paulo.

- [ ] Gasto bruto por conta: a seção “Conferência com o total da conta” tem que bater com o
      Gerenciador.
- [ ] O `destination_type` de cada conjunto das campanhas mapeadas é `WHATSAPP`. Se algum vier misto ou
      divergente, ele aparece em “Pendências”.
- [ ] As conversas de cada campanha WhatsApp batem com a coluna **“Conversas por mensagem iniciadas”**
      da UI (`onsite_conversion.messaging_conversation_started_7d`).
- [ ] As 3 campanhas da CA02 que estão fora do mapa (incluindo as duas “TRAF 25/11”) foram classificadas
      pelo destino real e adicionadas a `config/campaign-map.json`.
- [ ] VideoView e LP aparecem em “Fora da captação”, e o gasto delas não entra em nenhum CPL.
- [ ] A versão efetiva da API foi registrada. Opcional: fixar `META_API_VERSION` nela.
- [ ] O campo `instagram_profile_follow` é aceito na versão efetiva. Hoje ele só é relevante quando
      houver campanha de seguidores.
- [ ] A regra de atribuição (`use_unified_attribution_setting=true`) e o `action_report_time` padrão
      foram conferidos contra o que a UI mostra.
- [ ] O imposto foi confirmado com a área fiscal. Enquanto não for, o rótulo continua ESTIMATIVA.
- [ ] Ao conferir cada campanha, troque `"validation": "pendente"` por
      `"validation": "conferido DD/MM/AAAA"` no mapa. A UI mostra quantas ainda estão pendentes.

## 3. Aprovação e publicação

1. Defina `PUBLIC_DATA_APPROVED=true`.
2. Rode *Run workflow* e acompanhe os três jobs até ficarem verdes.
3. Abra https://scale-ag.github.io/dash-medclinic/ e confira o chip “Atualizado”, a cobertura e a seção
   de metodologia.
4. Configure o agendamento externo conforme [SETUP-CRON.md](../SETUP-CRON.md). Esse agendamento usa um
   token GitHub distinto, restrito a este repositório.

## 4. Operação

- **Falha de coleta ou validação:** o site anterior permanece no ar e o atraso aparece no chip de status.
  Verifique o log da execução, que não contém valores nem token.
- **Token expirado** (code 190): a mensagem pede a renovação do secret. Não há retry.
- **Mudança de `DATA_START`:** força backfill completo automaticamente.
- **Recoletar tudo:** *Run workflow* com `full_backfill = true`.
- **Despublicar:** desative o Pages ou volte `PUBLIC_DATA_APPROVED` para `false`. A segunda opção só
  impede **novas** publicações e não remove o site que já está no ar.
