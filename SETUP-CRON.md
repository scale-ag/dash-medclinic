# SETUP-CRON — MedClinic | Atualização dashboard

Este agendamento externo dispara o workflow `deploy.yml` **a cada 30 minutos** no fuso
**America/Sao_Paulo**.

O próprio workflow tem uma contingência horária (`cron: '41 * * * *'`, em UTC), mas o GitHub pode
atrasar ou pular execuções agendadas. Em repositório público, ele também desativa o agendamento após
60 dias sem atividade no repositório.

> Este documento **não** cria tokens, **não** altera crons existentes e **não** amplia acessos. Ele só
> descreve a configuração, que é feita manualmente por quem administra o serviço de cron.

## Tarefa

| Campo | Valor |
|---|---|
| Nome | `MedClinic \| Atualização dashboard` |
| Frequência | a cada 30 minutos (ex.: `*/30 * * * *`) |
| Fuso | `America/Sao_Paulo` |
| Método | `POST` |
| URL | `https://api.github.com/repos/scale-ag/dash-medclinic/actions/workflows/deploy.yml/dispatches` |
| Corpo | `{"ref":"main"}` |

### Headers

```
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2026-03-10
Authorization: Bearer <TOKEN_GITHUB_DO_CRON>
```

- `X-GitHub-Api-Version`: a versão `2026-03-10` aparece como suportada na página oficial de versões
  da API do GitHub (consultada em 25/11/2026). A `2022-11-28` também é suportada e é usada quando o
  header não é enviado.
- `<TOKEN_GITHUB_DO_CRON>` é um placeholder. O token real fica **somente** no cofre do serviço de cron.

## Token do cron (GitHub)

- O token do cron é **distinto** do token da Meta. Nunca reutilize `META_ACCESS_TOKEN` aqui, nem o
  contrário.
- Use um **fine-grained personal access token** com estas restrições:
  - Resource owner: `scale-ag`.
  - Repository access: **Only select repositories**, com **somente** `scale-ag/dash-medclinic`.
  - Repository permissions: **Actions: Read and write** e **Metadata: Read-only** (o GitHub marca
    Metadata automaticamente). Nenhuma outra permissão.
  - Uma expiração definida, com rotação registrada.
- Não grave o token em repositório, planilha, log ou chat.

## Teste manual (opcional)

Use o token no ambiente do seu terminal. Não cole o token na linha de comando de máquinas
compartilhadas.

```bash
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -H "Authorization: Bearer ${TOKEN_GITHUB_DO_CRON}" \
  -d '{"ref":"main"}' \
  -w '\nHTTP %{http_code}\n' \
  https://api.github.com/repos/scale-ag/dash-medclinic/actions/workflows/deploy.yml/dispatches
```

### Respostas esperadas

- **200**: é o comportamento documentado na versão `2026-03-10`. O corpo traz `workflow_run_id`,
  `run_url` e `html_url`. Registre o `workflow_run_id` para acompanhar a execução.
- **204** (sem corpo): é o comportamento antigo, que integrações e documentação anteriores descrevem.
  Também significa “aceito”.
- **401/403/404**: o token é inválido, não tem `Actions: write` ou não enxerga o repositório.
  O cron não deve repetir em loop. O erro precisa ser investigado.
- **422**: `ref` ou workflow inválido. Confira o corpo `{"ref":"main"}` e o nome `deploy.yml`.

**Aceitação não comprova deploy.** O 200 ou 204 só informa que o disparo foi enfileirado. Para
confirmar a atualização:

1. Acompanhe a execução (pelo `html_url`/`run_url` do 200, ou em *Actions → Deploy dashboard*) até
   os jobs **Testes**, **Coletar, montar e validar** e **Publicar no GitHub Pages** ficarem verdes.
2. Abra https://scale-ag.github.io/dash-medclinic/ e confira o chip “Atualizado” e a seção
   “Coleta, cobertura e metodologia”, que mostram o horário real da última coleta por conta.

Se a coleta, a validação ou o portão de aprovação falhar, o site **continua mostrando a última versão
válida**, com o horário real dela, e o atraso fica visível.

## Antes de ativar

O cron só faz sentido depois de concluídos os passos de [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md):
secret cadastrado, coleta real validada e `PUBLIC_DATA_APPROVED=true`. Sem esses passos, cada disparo
termina em falha controlada (secret ausente ou publicação bloqueada) e nada é publicado.

A concorrência é controlada pelo `concurrency: medclinic-pages-deploy` do workflow. Execuções não
rodam em paralelo e a execução em andamento nunca é cancelada. Fica no máximo uma pendente: o GitHub
descarta a pendente mais antiga quando chega outra.
