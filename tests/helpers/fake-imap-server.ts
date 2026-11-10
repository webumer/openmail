import { createServer, type Server, type Socket } from "node:net";

/**
 * A minimal IMAP server on loopback for transport-level tests with the real
 * imapflow client. It accepts any login, answers EXAMINE for one message, and
 * hands each UID FETCH to `onFetch`, which writes the untagged response itself.
 */
export interface FakeImapServer {
  port: number;
  /** Commands received, without tags. */
  commands: string[];
  /** Resolves when the client socket has closed. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export type FetchHandler = (command: string, socket: Socket, done: (status?: string) => void) => void;

export async function startFakeImapServer(onFetch: FetchHandler): Promise<FakeImapServer> {
  const commands: string[] = [];
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); markClosed(); });
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, ...rest] = line.split(" ");
        const command = rest.join(" ");
        commands.push(command);
        const verb = (rest[0] ?? "").toUpperCase();
        const reply = (text: string) => { if (!socket.destroyed) socket.write(text); };
        if (verb === "CAPABILITY") reply(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (verb === "LOGIN") reply(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`);
        else if (verb === "EXAMINE" || verb === "SELECT") {
          reply(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 10] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
        } else if (verb === "UID" && (rest[1] ?? "").toUpperCase() === "FETCH") {
          onFetch(command, socket, (status = "OK done") => reply(`${tag} ${status}\r\n`));
        } else if (verb === "LOGOUT") {
          reply(`* BYE bye\r\n${tag} OK done\r\n`);
          socket.end();
        } else reply(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    commands,
    closed,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
