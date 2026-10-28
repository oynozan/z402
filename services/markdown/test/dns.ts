/** A local DNS server for resolver tests: fixed A and AAAA answers and NXDOMAIN for other names, or no answer at all */
import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";
import ipaddr from "ipaddr.js";

export interface DnsServer {
  /** 127.0.0.1:<port>, for dnsResolver */
  server: string;
  /** "A name" or "AAAA name", in the order the queries arrived */
  queries: string[];
  close(): Promise<void>;
}

const TYPE_A = 1;
const TYPE_AAAA = 28;

/** The question's name and type, and where the question ends */
function question(msg: Buffer): { name: string; type: number; end: number } {
  const labels: string[] = [];
  let at = 12;
  for (let size = msg[at] ?? 0; size !== 0; size = msg[at] ?? 0) {
    labels.push(msg.subarray(at + 1, at + 1 + size).toString("latin1"));
    at += 1 + size;
  }
  return { name: labels.join(".").toLowerCase(), type: msg.readUInt16BE(at + 1), end: at + 5 };
}

function record(type: number, address: string): Buffer {
  const data = Buffer.from(ipaddr.parse(address).toByteArray());
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt32BE(60, 6);
  head.writeUInt16BE(data.length, 10);
  return Buffer.concat([head, data]);
}

export async function startDns(answers: Record<string, string[]> | "silent"): Promise<DnsServer> {
  const socket = createSocket("udp4");
  const queries: string[] = [];
  socket.on("message", (msg, from) => {
    const q = question(msg);
    queries.push(`${q.type === TYPE_AAAA ? "AAAA" : "A"} ${q.name}`);
    if (answers === "silent") return;
    const known = answers[q.name];
    const records = (known ?? [])
      .filter((address) => (q.type === TYPE_A ? isIPv4(address) : q.type === TYPE_AAAA && !isIPv4(address)))
      .map((address) => record(q.type, address));
    const head = Buffer.alloc(12);
    msg.copy(head, 0, 0, 2);
    // A response to a recursive query; NXDOMAIN for a name it does not know
    head.writeUInt16BE(known === undefined ? 0x8183 : 0x8180, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(records.length, 6);
    socket.send(Buffer.concat([head, msg.subarray(12, q.end), ...records]), from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    server: `127.0.0.1:${socket.address().port}`,
    queries,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
