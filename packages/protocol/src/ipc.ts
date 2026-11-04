/**
 * `@mangostudio/protocol/ipc`: the NDJSON transport over a Unix domain socket
 * or a Windows named pipe. This entry may import `node:`; the core entry may
 * not.
 */

export {
  type ConnectIpcOptions,
  connectIpc,
  type IpcOptions,
  type IpcServer,
  type IpcCloseOutcome,
  ipcPath,
  listenIpc,
} from './transports/ipc';
