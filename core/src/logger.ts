import * as fs from 'fs';
import * as path from 'path';

export class Logger {
  private static logFilePath: string = process.env.SWARMX_LOG_PATH || '/tmp/swarmx-core.log';
  private static writeStream: fs.WriteStream | null = null;

  public static init(customPath?: string): void {
    if (customPath) {
      this.logFilePath = customPath;
    }
    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a', mode: 0o600 });
    } catch (e) {
      console.warn(`[LOGGER] Warning: Could not initialize log file at ${this.logFilePath}:`, e);
    }
  }

  private static logWithTag(tag: string, message: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `${timestamp} [${tag}] ${message}`;
    
    // Output to console with structured tag
    console.log(`[${tag}] ${message}`);

    // Append to log file
    if (this.writeStream) {
      try {
        this.writeStream.write(formatted + '\n');
      } catch (e) {
        // Ignore write failures in high-concurrency shutdown
      }
    } else {
      // Lazy write
      try {
        fs.appendFileSync(this.logFilePath, formatted + '\n', { mode: 0o600 });
      } catch (e) {}
    }
  }

  public static transport(message: string): void {
    this.logWithTag('TRANSPORT', message);
  }

  public static handshake(message: string): void {
    this.logWithTag('HANDSHAKE', message);
  }

  public static capabilities(message: string): void {
    this.logWithTag('CAPABILITIES', message);
  }

  public static pairing(message: string): void {
    this.logWithTag('PAIRING', message);
  }

  public static registration(message: string): void {
    this.logWithTag('REGISTRATION', message);
  }

  public static workerState(message: string): void {
    this.logWithTag('WORKER STATE', message);
  }

  public static execution(message: string): void {
    this.logWithTag('EXECUTION', message);
  }

  public static validation(message: string): void {
    this.logWithTag('VALIDATION', message);
  }

  public static error(message: string): void {
    this.logWithTag('ERROR', message);
  }

  public static close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}
