import * as net from 'net';

export interface IpcResponse<T = any> {
  id: string | number;
  result?: T;
  error?: string;
}

export class CoreIpcClient {
  private socketPath: string;
  private socket: net.Socket | null = null;
  private pendingRequests: Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private reqId: number = 1;
  private isConnected: boolean = false;

  constructor(socketPath: string = '/tmp/swarmx.sock') {
    this.socketPath = socketPath;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        this.isConnected = true;
        resolve();
      });

      let buffer = '';
      this.socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const res: IpcResponse = JSON.parse(line);
            const pending = this.pendingRequests.get(res.id);
            if (pending) {
              if (res.error) {
                pending.reject(new Error(res.error));
              } else {
                pending.resolve(res.result);
              }
              this.pendingRequests.delete(res.id);
            }
          } catch (e) {
            console.error('Failed to parse IPC message:', e);
          }
        }
      });

      this.socket.on('error', (err) => {
        this.isConnected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.isConnected = false;
        this.socket = null;
        for (const [id, pending] of this.pendingRequests.entries()) {
          pending.reject(new Error('Connection closed by SwarmX host'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  public request<T = any>(method: string, params?: any): Promise<T> {
    if (!this.isConnected || !this.socket) {
      return Promise.reject(new Error('SwarmX Core Daemon is not connected'));
    }

    const id = this.reqId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.socket!.write(payload);
    });
  }

  public get connected(): boolean {
    return this.isConnected;
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.isConnected = false;
    }
  }
}
