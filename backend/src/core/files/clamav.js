import net from 'node:net';

// clamd INSTREAM client (ADR-004): the file is streamed to ClamAV over TCP
// and never executed or opened by anything else first.

const CHUNK = 64 * 1024;
const TIMEOUT_MS = 60000;

export function createClamav({ host, port }, { connect = net.createConnection } = {}) {
  return {
    // Resolves { clean: true } or { clean: false, signature }. Rejects if
    // ClamAV cannot be reached or answers anything else (fail closed).
    scan(stream) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        let answer = '';
        const fail = (error) => {
          socket.destroy();
          stream.destroy();
          reject(error);
        };
        socket.setTimeout(TIMEOUT_MS, () => fail(new Error('clamav timeout')));
        socket.on('error', fail);
        socket.on('data', (data) => { answer += data.toString('latin1'); });
        socket.on('end', () => {
          const text = answer.replace(/\0+$/, '').trim();
          if (text === 'stream: OK') resolve({ clean: true });
          else if (/^stream: .+ FOUND$/.test(text)) resolve({ clean: false, signature: text.slice(8, -6) });
          else reject(new Error(`unexpected clamav answer: ${text.slice(0, 100)}`));
        });
        socket.on('connect', async () => {
          socket.write('zINSTREAM\0');
          try {
            for await (const data of stream) {
              for (let offset = 0; offset < data.length; offset += CHUNK) {
                const chunk = data.subarray(offset, offset + CHUNK);
                const size = Buffer.alloc(4);
                size.writeUInt32BE(chunk.length);
                if (!socket.write(Buffer.concat([size, chunk]))) await new Promise((r) => socket.once('drain', r));
              }
            }
            socket.write(Buffer.alloc(4));
          } catch (error) {
            fail(error);
          }
        });
      });
    },
  };
}
