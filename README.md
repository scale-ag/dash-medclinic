# dash-medclinic

Dashboard MedClinic (Bauru/SP): captação via Meta Ads, medida em **conversas iniciadas no WhatsApp** e
seguidores, por médico.

- **Dr. Ailton**: endocrinologia e medicina do esporte.
- **Dra. Taísa**: dermatologia e tricologia.

> **Status:** implementação completa, com testes automatizados. A **implantação real está PENDENTE**:
> nenhuma coleta real foi feita a partir deste repositório e nenhum dado real foi publicado.
> Ainda faltam o secret, as variáveis, a validação contra a UI da Meta e a aprovação de publicação.
> Os passos estão em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

O resultado de captação é **conversa iniciada no WhatsApp**. Não é paciente, agendamento nem consulta.
Não há Google, CRM, planilhas de leads, ROAS nem faturamento.

## Visões

| Aba | Conteúdo |
|---|---|
| Geral | Investimento total e por categoria: WhatsApp, Seguidores, Fora da captação e Pendente. Comparativo entre médicos, cada custo com o próprio denominador. Conciliação: categorias, conferência com o total da conta e lista de pendências. Seção de coleta e metodologia. |
| WhatsApp Taísa / WhatsApp Ailton | Investimento, conversas iniciadas, custo por conversa, impressões, cliques no link, CTR, CPC e CPM. Gráficos diários de gasto, resultado e custo. Tabela diária. Drill-down campanha → conjunto → anúncio. |
| Seguidores Ailton / Seguidores Taísa | Hoje mostram o estado honesto *“Nenhuma campanha de seguidores identificada”*. A visão é ativada pelo mapa de campanhas. |

Os filtros (período, campanha, conjunto e anúncio) valem para todas as abas.

- **Presets:** ontem, últimos 7 dias completos, mês até ontem, mês anterior e personalizado.
- **Hoje** só entra no período personalizado e aparece sempre marcado como **parcial**.
- **Exportar CSV** usa os mesmos filtros e protege contra *formula injection*.
- **Imposto Meta** vem ligado por padrão e é rotulado **ESTIMATIVA**.
- **Recarregar dados** relê o snapshot publicado. Esse botão **não** dispara uma nova coleta.

## Arquitetura

```
Meta Marketing API (somente leitura, Bearer só p/ graph.facebook.com)
   │  anúncio/dia, paginação completa, janelas de 7 dias, retry limitado
   ▼
scripts/collect.mjs ──► .work/snapshot.json (atômico; falha = nada gravado)
   ▲ base incremental = último snapshot PUBLICADO (scripts/fetch-base.mjs)
   ▼
scripts/build.mjs ──► dist/ (HTML/JS estático + data/snapshot.json + data/config.json)
   ▼
scripts/validate-dist.mjs (produção, cobertura, conciliação, frescor, varredura de credenciais)
   ▼
scripts/publish-gate.mjs (PUBLIC_DATA_APPROVED=true)
   ▼
actions/upload-pages-artifact + actions/deploy-pages ──► https://scale-ag.github.io/dash-medclinic/
```

- O projeto **não tem dependências npm** (Node ≥ 22). Os gráficos são SVG próprios e não há CDN.
  A página usa uma CSP restritiva.
- `src/shared/`: lógica compartilhada entre Node e navegador (datas, classificação, métricas, filtros, CSV).
- `src/node/`: código só de Node: cliente Meta, coletor, snapshot e verificações.
- `src/web/`: o dashboard.
- `config/`: allowlist de contas, mapa de campanhas e parâmetros de coleta e exibição. Nenhum desses
  arquivos contém segredos.
- `.github/workflows/deploy.yml`: dispara com `push` na main, `workflow_dispatch` e uma contingência
  horária. `ci.yml` roda nos PRs, sem secrets.

Detalhes de cálculo, classificação, atribuição e persistência estão em
[docs/METODOLOGIA.md](docs/METODOLOGIA.md). O agendamento externo de 30 em 30 minutos está em
[SETUP-CRON.md](SETUP-CRON.md).

## Comandos locais

Testes automatizados: sem rede, sem secrets, só com dados sintéticos isolados.

```bash
npm test
```

Preview local com dados **SINTÉTICOS**, servido em http://localhost:8787/dash-medclinic/. A página mostra
a faixa “DADOS SINTÉTICOS”.

```bash
npm run preview:synthetic
```

Inspeção de UI (desktop e mobile, tema claro e escuro). Requer Playwright na máquina; fica fora do CI.

```bash
npm run ui-check
```

Coleta **real** local, para validação antes da aprovação. O token fica só no ambiente do seu terminal.

```bash
META_ACCESS_TOKEN=... META_APP_ID=... npm run collect -- --out .work/snapshot.json
```

```bash
npm run build -- --snapshot .work/snapshot.json --out dist
```

```bash
npm run validate -- --dist dist
```

```bash
npm run preview
```

`.work/`, `dist/` e `data/` estão no `.gitignore`: **dados reais nunca são versionados**.

## Segurança

- O token Meta vem apenas do secret `META_ACCESS_TOKEN`. Ele vai somente no header
  `Authorization: Bearer` e somente para `https://graph.facebook.com`. Ele nunca aparece em URL, log,
  frontend ou git.
- As URLs de paginação passam por validação de host e de caminho. Qualquer `access_token` nelas é removido.
  Redirects são proibidos.
- Só as contas `203811442663021` (CA01) e `1530307658790959` (CA02) são consultadas. Qualquer outra é
  bloqueada antes da requisição.
- A integração faz somente leitura e não precisa de permissão de escrita na Meta.
- O repositório é **público**, então os logs de Actions também são. Por isso os logs trazem só contagens,
  coberturas e datas, nunca valores monetários.
