// Redação de segredos em qualquer texto que possa ir para log/erro.

export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) s = s.split(secret).join('[REDACTED]');
  }
  s = s.replace(/access_token=[^&\s"'<>]+/gi, 'access_token=[REDACTED]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[A-Za-z0-9._\-~+/=]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/bearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bEAA[A-Za-z0-9]{16,}/g, '[REDACTED]');
  return s;
}

/** Logger que SEMPRE redige o token antes de escrever. Logs nunca incluem valores monetários. */
export function createLogger({ secrets = [], write = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const out = (level, msg) => write(`[${level}] ${redact(msg, secrets)}`);
  return {
    info: (m) => out('info', m),
    warn: (m) => out('warn', m),
    error: (m) => out('erro', m),
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
