import nodemailer from "nodemailer";
import type { AccountCredentials } from "../store/types.js";
import { toSmtpError } from "../errors.js";
import { defaultResolver, resolveHostTarget, type Resolver } from "./address-guard.js";
import { buildSmtpConnectOptions, type SmtpConnectOptions } from "./tls.js";

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

export interface SmtpMessage {
  raw: Buffer;
  envelope: SmtpEnvelope;
}

export interface SmtpClient {
  send(message: SmtpMessage): Promise<{ messageId: string }>;
  verify(): Promise<void>;
  close(): void;
}

export type SmtpClientFactory = (options: SmtpConnectOptions) => SmtpClient;

export interface SmtpGateway {
  send(account: AccountCredentials, message: SmtpMessage): Promise<{ messageId: string }>;
  verify(account: AccountCredentials): Promise<void>;
}

export interface SmtpGatewayOptions {
  /** DNS lookup used to pin each connection to a checked public address. Tests inject one. */
  resolve?: Resolver;
}

export function createSmtpGateway(
  factory: SmtpClientFactory = defaultClient,
  gatewayOptions: SmtpGatewayOptions = {},
): SmtpGateway {
  const resolve = gatewayOptions.resolve ?? defaultResolver;
  return {
    async send(account, message) {
      return run(factory, resolve, account, (client) => client.send(message));
    },
    async verify(account) {
      await run(factory, resolve, account, (client) => client.verify());
    },
  };
}

async function run<T>(
  factory: SmtpClientFactory,
  resolve: Resolver,
  account: AccountCredentials,
  fn: (client: SmtpClient) => Promise<T>,
): Promise<T> {
  const secrets = [account.password, account.smtpAuth.pass];
  // Refuse cleartext before DNS, then pin the socket to an address checked just now.
  const options = buildSmtpConnectOptions(account);
  let target;
  try {
    target = await resolveHostTarget(
      {
        host: account.smtp.host,
        allowInsecureLocalhost: account.allowInsecureLocalhost,
        ...(account.insecureSmtpHosts ? { insecureHosts: account.insecureSmtpHosts } : {}),
        protocol: "SMTP",
      },
      resolve,
    );
  } catch (err) {
    throw toSmtpError(err, secrets);
  }
  options.host = target.host;
  if (target.servername) options.tls.servername = target.servername;
  const client = factory(options);
  try {
    return await fn(client);
  } catch (err) {
    throw toSmtpError(err, secrets);
  } finally {
    try {
      client.close();
    } catch {
      // The socket is already unusable.
    }
  }
}

function defaultClient(options: SmtpConnectOptions): SmtpClient {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS,
    ignoreTLS: options.ignoreTLS,
    auth: options.auth,
    logger: false,
    debug: false,
    connectionTimeout: options.connectionTimeout,
    greetingTimeout: options.greetingTimeout,
    socketTimeout: options.socketTimeout,
    tls: {
      rejectUnauthorized: true,
      ...(options.tls.servername ? { servername: options.tls.servername } : {}),
    },
  });
  return {
    async send(message) {
      const info = await transport.sendMail({
        raw: message.raw,
        envelope: { from: message.envelope.from, to: message.envelope.to },
      });
      const messageId = info && typeof info === "object" && "messageId" in info && typeof info.messageId === "string" ? info.messageId : "";
      return { messageId };
    },
    async verify() {
      await transport.verify();
    },
    close() {
      transport.close();
    },
  };
}
