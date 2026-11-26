# dash-medclinic

Dashboard MedClinic (Bauru/SP): captação via Meta Ads, medida em **conversas iniciadas no WhatsApp** e
seguidores, por médico.

- **Dr. Ailton**: endocrinologia e medicina do esporte.
- **Dra. Taísa**: dermatologia e tricologia.

Painel público em [MedClinic](https://scale-ag.github.io/dash-medclinic/). A coleta diária por anúncio alimenta as cinco visões. A configuração da atualização automática está em [Implantação](docs/IMPLANTACAO.md).

O resultado de captação é **conversa iniciada no WhatsApp**. Não é paciente, agendamento nem consulta.
Não há Google, CRM, planilhas de leads, ROAS nem faturamento.

A CA03 contém impulsionamentos identificados pelo perfil do criativo. Cada conjunto precisa apontar para o Instagram do médico e ter destino, otimização ou botão de visita ao perfil. O painel conta os seguidores atribuídos pela Meta. O histórico disponível começa em maio de 2025.

## Visões

| Aba | Conteúdo |
|---|---|
| Geral | Investimento total e por categoria: WhatsApp, Seguidores, Fora da captação e Pendente. Comparativo entre médicos, cada custo com o próprio denominador. Conciliação: categorias, conferência com o total da conta e lista de pendências. Seção de coleta e metodologia. |
| WhatsApp Taísa / WhatsApp Ailton | Investimento, conversas iniciadas, custo por conversa, impressões, cliques no link, CTR, CPC e CPM. Gráficos diários de gasto, resultado e custo. Tabela diária. Drill-down campanha → conjunto → anúncio. |
| Seguidores Ailton / Seguidores Taísa | Mostram somente campanhas (ou conjuntos de campanhas mistas por médico) exclusivas de seguidores. Distinguem “campanha identificada sem veiculação no período” de “nenhuma campanha identificada”. Conjuntos com médico a confirmar não contam para ninguém. |

**Layout (padrão visual dos dashboards da agência Scale):**

- **Menu lateral fixo** com as cinco visões. No celular, ele recolhe e abre por um botão.
- **Barra superior:** período, “Remover Filtros”, Imposto Meta, tema, última atualização e “Atualizar Dados”.
- **Filtros secundários:** campanha, conjunto e anúncio, mais a exportação CSV, numa linha compacta abaixo da barra.
- **Primeira dobra:** à esquerda, coluna de indicadores em formato de funil (investimento, impressões, cliques e resultado). À direita, painel com o gráfico combinado diário e a tabela diária. O gráfico mostra barras de resultado e linhas de investimento e custo, com o eixo de quantidade à esquerda e o de R$ à direita. A tabela tem heatmap por coluna e total fixo.
- **Abaixo:** comparativo por médico (na Geral), três tabelas de campanhas, conjuntos e anúncios com os nomes da Meta, totais e gráficos por dia, e a conciliação e a metodologia em seções recolhidas.

Os filtros (período, campanha, conjunto e anúncio) valem para todas as abas.

- **Presets:** hoje, ontem, 3/7/14/30 dias incluindo hoje, este mês, mês passado, todo o período e duas datas personalizadas. Os atalhos de sete dias completos e mês até ontem também estão disponíveis.
- Quando o período inclui **hoje**, o painel sinaliza o dia parcial.
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

Preview local com dados **SINTÉTICOS**, servido em http://127.0.0.1:8787/dash-medclinic/. O servidor escuta só
em 127.0.0.1, então a prévia não fica exposta na rede local. A página mostra a faixa “DADOS SINTÉTICOS”.

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
- A coleta consulta CA01 (`203811442663021`), CA02 (`1530307658790959`) e CA03 (`714614090427249`). Qualquer outra é
  bloqueada antes da requisição.
- A integração faz somente leitura e não precisa de permissão de escrita na Meta.
- O repositório é **público**, então os logs de Actions também são. Por isso os logs trazem só contagens,
  coberturas e datas, nunca valores monetários.
