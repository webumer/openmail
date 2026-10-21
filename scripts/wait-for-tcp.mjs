import net from "node:net";

const timeoutMs = 60_000;
const pairs = process.argv.slice(2);
if (pairs.length < 2 || pairs.length % 2 !== 0) {
  console.error("usage: node scripts/wait-for-tcp.mjs host port [host port...]");
  process.exit(1);
}

const targets = [];
for (let index = 0; index < pairs.length; index += 2) {
  const host = pairs[index];
  const port = Number(pairs[index + 1]);
  if (!host || !Number.isInteger(port) || port < 1) {
    console.error(`Invalid target ${host ?? ""}:${pairs[index + 1] ?? ""}`);
    process.exit(1);
  }
  targets.push({ host, port });
}

function probe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const started = Date.now();
for (const target of targets) {
  for (;;) {
    if (await probe(target.host, target.port)) {
      console.log(`Ready: ${target.host}:${target.port}`);
      break;
    }
    if (Date.now() - started > timeoutMs) {
      console.error(`Timed out waiting for ${target.host}:${target.port}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
