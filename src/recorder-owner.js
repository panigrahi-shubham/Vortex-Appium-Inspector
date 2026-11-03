import net from 'node:net';

// A host-wide socket owns real-device automation. The OS releases it on crash.
// Different UI ports/state folders must not create independent device owners.
export async function acquireRecorderOwner(port = 4699) {
  const owner = net.createServer((socket) => socket.end('Vortex recorder ownership\n'));
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  }).catch((error) => {
    if (error.code === 'EADDRINUSE') throw new Error(`Recorder ownership port ${port} is occupied. Close the existing recorder before starting another instance; recovery has not run.`);
    throw error;
  });
  return owner;
}
