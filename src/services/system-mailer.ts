import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { envInteger } from "../config/runtime.js";
import { MailError } from "../errors.js";

export interface SystemMailer {
  configured: boolean;
  sendPasswordReset(to: string, link: string, code: string): Promise<void>;
}

export const unconfiguredMailer: SystemMailer = {
  configured: false,
  async sendPasswordReset() { throw new MailError("config_error", "System email is not configured"); },
};

interface SystemTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close(): void;
}

export function createSystemMailer(
  env: NodeJS.ProcessEnv = process.env,
  factory: (options: SMTPTransport.Options) => SystemTransport = (options) => nodemailer.createTransport(options),
): SystemMailer {
  const host = env.OPENMAIL_SYSTEM_SMTP_HOST?.trim();
  const user = env.OPENMAIL_SYSTEM_SMTP_USER?.trim();
  const pass = env.OPENMAIL_SYSTEM_SMTP_PASS;
  const from = env.OPENMAIL_SYSTEM_SMTP_FROM?.trim();
  const port = envInteger(env, "OPENMAIL_SYSTEM_SMTP_PORT", 465, 1, 65535);
  const secureValue = env.OPENMAIL_SYSTEM_SMTP_SECURE ?? "1";
  if (secureValue !== "1" && secureValue !== "0") throw new MailError("config_error", "OPENMAIL_SYSTEM_SMTP_SECURE must be 1 or 0");
  if (!host || !user || !pass || !from) return unconfiguredMailer;
  const secure = secureValue === "1";
  return {
    configured: true,
    async sendPasswordReset(to, link, code) {
      let transport: SystemTransport | undefined;
      try {
        transport = factory({
          host, port, secure, requireTLS: !secure, ignoreTLS: false,
          auth: { user, pass },
          tls: { rejectUnauthorized: true },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 60_000,
          logger: false,
          debug: false,
        });
        await transport.sendMail({
          from, to, subject: "Reset your OpenMail password",
          text: `You asked to reset your OpenMail login password.\n\nOpen this link:\n${link}\n\nOr paste this code on the reset page:\n${code}\n\nThe link and code expire in 30 minutes and work once. If you did not ask for this, ignore this email.\n`,
        });
      } catch {
        throw new MailError("smtp_error", "Password reset email could not be delivered");
      } finally {
        try {
          transport?.close();
        } catch {
          // Already closed.
        }
      }
    },
  };
}
