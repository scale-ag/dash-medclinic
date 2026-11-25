#!/usr/bin/env node
// Portão de publicação: dados comerciais só vão a público com aprovação explícita.
// Falha (exit 1) enquanto a variável de repositório PUBLIC_DATA_APPROVED não for exatamente "true".
const v = process.env.PUBLIC_DATA_APPROVED;
if (v !== 'true') {
  console.error(
    `[erro] Publicação bloqueada: PUBLIC_DATA_APPROVED=${JSON.stringify(v ?? null)}. ` +
      'Dados comerciais da MedClinic só são publicados após aprovação final (definir a variável de repositório PUBLIC_DATA_APPROVED=true). ' +
      'Coleta e validação concluíram; nada foi enviado ao GitHub Pages; o site anterior (se houver) permanece.',
  );
  process.exit(1);
}
console.log('Publicação aprovada (PUBLIC_DATA_APPROVED=true).');
