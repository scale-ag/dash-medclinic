// Verificações pré-publicação: conciliação conta x anúncios, frescor e varredura de segredos.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Compara o gasto total da conta (level=account) com a soma das linhas anúncio/dia, por conta. */
export function accountReconciliation(snapshot, { maxAbsDiffBRL = 1, maxRelDiff = 0.01 } = {}) {
  return snapshot.accounts.map((a) => {
    const accountCents = Object.values(a.days || {}).reduce((s, d) => s + (d.account_spend_cents || 0), 0);
    const adCents = snapshot.rows.filter((r) => r.account_id === a.id).reduce((s, r) => s + r.spend_cents, 0);
    const diff = Math.abs(accountCents - adCents);
    const tolerance = Math.max(Math.round(maxAbsDiffBRL * 100), Math.round(accountCents * maxRelDiff));
    return { label: a.label, ok: diff <= tolerance, diff_cents: diff, tolerance_cents: tolerance };
  });
}

const SECRET_PATTERNS = [
  { name: 'token Meta (EAA…)', re: /EAA[A-Za-z0-9]{16,}/ },
  { name: 'parâmetro access_token', re: /access_token\s*[=:]/i },
  { name: 'header Authorization Bearer', re: /Bearer\s+[A-Za-z0-9._\-~+/=]{16,}/ },
  { name: 'token GitHub', re: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/ },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Varre todos os arquivos do diretório publicado em busca de credenciais. */
export async function scanForSecrets(dir, { exactSecrets = [] } = {}) {
  const findings = [];
  for await (const file of walk(dir)) {
    if ((await stat(file)).size > 64 * 1024 * 1024) continue;
    const text = await readFile(file, 'utf8');
    for (const s of exactSecrets) {
      if (typeof s === 'string' && s.length >= 8 && text.includes(s)) findings.push({ file: relative(dir, file), pattern: 'valor exato de um secret' });
    }
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) findings.push({ file: relative(dir, file), pattern: p.name });
  }
  return findings;
}
