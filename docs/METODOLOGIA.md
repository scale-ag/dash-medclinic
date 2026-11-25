# Metodologia — dados, classificação e cálculo

## Fonte

A única fonte é a **Meta Marketing API, em modo somente leitura**. Ela substitui o Adveronix/Sheets.

| Item | Valor |
|---|---|
| Business | 437935417525828 |
| CA01 | `203811442663021` (Dr. Ailton, com histórico da Dra. Taísa) |
| CA02 | `1530307658790959` (Dra. Taísa) |
| Moeda / fuso | BRL / `America/Sao_Paulo`, conferidos na conta a cada execução; divergência = falha |
| Versão da API | `META_API_VERSION` (variável de repositório; padrão `v25.0`) |

### Versão solicitada x versão efetiva

A versão **solicitada** fica no caminho da URL. A versão **efetiva** vem do header de resposta
`facebook-api-version`. As duas são registradas no snapshot (`api.requested_version` e
`api.effective_versions`) e exibidas na seção de metodologia.

No teste local, a chamada para `/v25.0` respondeu `v27.0`. Quando as versões diferem, o coletor emite
um aviso. Depois da validação, considere fixar `META_API_VERSION=v27.0`.

### Verificação do app

Se a variável `META_APP_ID` estiver definida, o coletor chama `GET /app` e confere se o token pertence
a esse app. Se não pertencer, a coleta falha.

## Coleta

- **Insights:** `level=ad`, `time_increment=1`, `use_unified_attribution_setting=true`. O filtro
  `ad.effective_status` inclui anúncios pausados, arquivados e excluídos, para não perder gasto de
  campanhas pausadas.
- **Campos:** `account_id`, `campaign_id/name`, `adset_id/name`, `ad_id/name`, `date_start/stop`,
  `spend`, `impressions`, `inline_link_clicks`, `actions`, `instagram_profile_follow`.
- **Total diário da conta** (`level=account`): coletado para a conciliação.
- **Descoberta:** campanhas (`objective`, `effective_status`) e conjuntos (`destination_type`,
  `optimization_goal`, `attribution_spec`). Um conjunto ou campanha que aparece no insights sem ter sido
  descoberto é buscado por ID, e o coletor confirma que ele pertence à **mesma conta**.
- **Paginação completa:** o coletor segue `paging.next` até o fim. Cada `next` é validado: precisa ser
  `https://graph.facebook.com`, apontar para o mesmo recurso e não ter `access_token`, que é removido.
  Há limite de páginas e detecção de cursor repetido.
- **Janelas** de `WINDOW_DAYS` dias (padrão 7). Se a Meta pedir menos dados, a janela é dividida ao meio
  automaticamente.
- **Retry com backoff exponencial limitado** (até 5 tentativas, no máximo 60 s cada) só para falhas
  transitórias: 5xx, rede, `is_transient`, limite de taxa. Se a Meta pedir uma espera longa, a execução
  para sem publicar.
- **Autenticação e permissão** (códigos 190, 10, 200–299): falha imediata, com mensagem clara e sem
  retry.
- **Chave única** `conta + anúncio + dia`. Uma duplicata idêntica é descartada. Uma duplicata com
  valores diferentes é erro de integridade.
- **Valores:** o gasto é guardado em centavos inteiros e brutos (sem imposto). As contagens são inteiros.

### Histórico e reprocessamento

- **Histórico:** começa em `DATA_START` (padrão `2026-11-01`, configurável por variável de repositório)
  e vai até **hoje**. Hoje fica gravado como dia parcial.
- **Backfill inicial:** sem base válida, coleta de `DATA_START` até hoje.
- **Incremental:** a base é o último snapshot **publicado**. A cada execução são recoletados os últimos
  `REPROCESS_DAYS` dias (padrão 28), sempre incluindo o último dia da base, que pode ter sido parcial.
  Isso cobre revisões de atribuição. A janela recoletada **substitui integralmente** a base: linhas que
  sumiram na Meta também somem aqui. Os dias anteriores à janela são mantidos.
- O reprocessamento é **idempotente**: reexecutar com os mesmos dados da Meta produz as mesmas linhas.
- `workflow_dispatch` com `full_backfill=true` recoleta tudo desde `DATA_START`.

### Zero x ausência

Cada conta tem um mapa `days`. Um dia só aparece nele se a janela daquele dia foi consultada com
sucesso.

- **Dia coletado sem linhas:** zero **confirmado**.
- **Dia fora da cobertura** (antes de `DATA_START`, ou futuro): **sem coleta**. A UI mostra “sem coleta”
  e nunca R$ 0.

### Falha e persistência

- Qualquer falha em qualquer conta aborta a execução **sem gravar** nada (a escrita é atômica) e sem
  publicar. O último site válido continua no ar, com os timestamps reais por conta (`last_success_at`)
  e o atraso visível.
- A persistência é o próprio snapshot publicado (`/dash-medclinic/data/snapshot.json`). Ele contém
  linhas anúncio/dia, dimensões, cobertura e metadados, e **nenhuma credencial**.
- Enquanto não houver publicação aprovada, cada execução faz backfill completo, o que é barato porque o
  histórico começa em 01/11/2026. Nada é commitado no git.

## Classificação (mapa explícito)

Arquivo: `config/campaign-map.json`.

`campaign_id → { account_id, doctor, funnel }`. O médico **nunca** é deduzido pela conta nem pelo nome
(ENGJ/TRAF/DTS/DAT). Isso importa porque a CA01 contém histórico da Taísa.

Para cada conjunto (e, portanto, para cada linha), a categoria é definida assim:

| Situação | Categoria | Entra em custo? |
|---|---|---|
| Funil `whatsapp` e conjunto com `destination_type = WHATSAPP` | WhatsApp (conciliado) | CPL |
| Funil `seguidores` e conjunto com `destination_type = INSTAGRAM_PROFILE` (configurável) | Seguidores (conciliado) | CPS |
| Funil `excluido` (VideoView, LP/site) | Fora da captação | não |
| Mapeado, mas com destino misto (ex.: `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`), divergente (Messenger, IG Direct, site), desconhecido, ou campanha observada em outra conta | Mapeado, destino não conciliado | não |
| Campanha fora do mapa | Não classificado | não (a UI mostra só uma *sugestão*, nunca aplicada) |

- **Override por conjunto** (`adset_overrides`): opcional. Exige `accept_destination_type` exato e uma
  nota de conferência. Se o destino mudar, o override deixa de valer.
- **Pausadas com gasto:** são mantidas.
- **Nada é contado em dobro.** A conciliação da Geral distribui 100% do gasto entre as categorias e
  confere a soma dos anúncios contra o total da conta (`level=account`), com tolerância configurável.

### Mapa inicial (todas as entradas com validação **pendente** na UI da Meta)

| Conta | campaign_id | Observado | Médico | Funil |
|---|---|---|---|---|
| CA01 | 120242361567150317 | [WhatsApp][Taísa] | Taísa | whatsapp |
| CA01 | 120243388359980317 | [WhatsApp][Ailton] | Ailton | whatsapp |
| CA01 | 120248339618150317 | DTS Ads tricologia | Taísa | whatsapp |
| CA01 | 120248374076630317 | DAT WPP Top Ads | Ailton | whatsapp |
| CA01 | 120248471528140317 | DAT WPP Teste de Ads | Ailton | whatsapp |
| CA01 | 120246982288180317 | VideoView Taísa | Taísa | excluído (VideoView) |
| CA01 | 120246982670850317 | VideoView Ailton | Ailton | excluído (VideoView) |
| CA01 | 120248258608230317 | DTS LPV4 | Taísa | excluído (LP) |
| CA01 | 120248334203780317 | DTS LPV6 | Taísa | excluído (LP) |
| CA02 | 120251418554480262 | DTS ENGJ ABO Teste de Ads | Taísa | whatsapp |

- As **outras 3 campanhas da CA02** (incluindo as duas “TRAF 25/11”, que têm resultados diferentes na
  UI) **não estão no mapa**. Elas aparecem em “Pendências de conciliação” com o `destination_type`
  real de cada conjunto. A classificação delas deve ser decidida pelo destino e adicionada ao mapa.
- **Seguidores:** nenhuma campanha exclusiva foi confirmada. As duas abas de seguidores mostram
  “Nenhuma campanha de seguidores identificada”. Seguidores incidentais de campanhas de WhatsApp **não**
  são usados.

## Métricas

- **Conversas WhatsApp:** `actions[action_type = onsite_conversion.messaging_conversation_started_7d]`,
  somente em conjuntos WhatsApp conciliados. O cálculo **não** usa `total_messaging_connection` nem
  `first_reply`.
- **Seguidores:** campo `instagram_profile_follow` (não `_v2`, que é o da UI), somente em campanhas de
  seguidores conciliadas.
- **Atribuição:** `use_unified_attribution_setting=true`, ou seja, a configuração de atribuição de cada
  conjunto, como no Gerenciador de Anúncios. O `attribution_spec` de cada conjunto fica registrado.
  `action_report_time` usa o padrão da API (configurável em `config/dashboard.json`).
- **Alcance e frequência:** não são coletados nem exibidos. Alcance não pode ser somado entre dias ou
  anúncios, e o dashboard não inventa esses números.

### Fórmulas

Todos os custos são a razão dos totais do período, nunca a média de custos diários:

```
CPL = gasto WhatsApp conciliado ÷ conversas WhatsApp conciliadas
CPS = gasto de campanhas de seguidores ÷ seguidores dessas campanhas
CPC = gasto ÷ cliques no link (inline_link_clicks)
CPM = gasto ÷ impressões × 1000
CTR = cliques no link ÷ impressões × 100
```

Denominador zero resulta em **não calculável** (“—”), nunca R$ 0. Conversas e seguidores nunca são
somados, e nenhum dos dois é tratado como venda.

### Imposto Meta (ESTIMATIVA)

- Fica ligado por padrão. O fator é `1/0,8785 ≈ 1,138303927`, configurável em
  `config/dashboard.json` (`tax.net_share`). Ele **não** usa 1,13806.
- É aplicado **uma única vez**, sobre o total bruto, no cálculo de exibição. O bruto é sempre preservado
  e aparece no card e no CSV.
- O valor é rotulado **ESTIMATIVA** até a confirmação fiscal.
