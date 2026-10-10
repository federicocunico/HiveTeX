export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class MemoryMailer implements Mailer {
  sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
  }
  last(to?: string) {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

/** Gmail SMTP using a dedicated account + App Password (2-step verification required). */
export async function createGmailMailer(user: string, appPassword: string, fromName = 'HiveTeX'): Promise<Mailer> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: appPassword },
  });
  return {
    async send(msg) {
      await transport.sendMail({ from: `"${fromName}" <${user}>`, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * Chooses the SMTP transport: an explicit `SMTP_HOST` (e.g. Mailpit in the local docker stack) wins; otherwise Gmail
 * with `GMAIL_USER` / `GMAIL_APP_PASSWORD`, exactly as before. Returns null if neither is configured.
 */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (host) {
    const port = Number(env.SMTP_PORT ?? 587);
    return {
      host,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === '1' || env.SMTP_SECURE === 'true' : port === 465,
      ...(env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : {}),
      from: env.SMTP_FROM ?? env.GMAIL_USER ?? 'hivetex@localhost',
    };
  }
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return { host: 'smtp.gmail.com', port: 465, secure: true, user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD, from: env.GMAIL_USER };
  }
  return null;
}

export async function createSmtpMailer(s: SmtpSettings, fromName = 'HiveTeX'): Promise<Mailer> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    ...(s.user ? { auth: { user: s.user, pass: s.pass ?? '' } } : {}),
  });
  return {
    async send(msg) {
      await transport.sendMail({ from: `"${fromName}" <${s.from}>`, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
