import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { logger } from '../logger/logger';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class ProcessRunner {
  /**
   * Kill a child process in a cross-platform way.
   * SIGKILL does not work on Windows, so we use 'TASKKILL /F /PID' as fallback.
   */
  private killProcess(pid: number): void {
    if (platform() === 'win32') {
      try {
        spawn('taskkill', ['/F', '/PID', String(pid)]);
      } catch {
        // taskkill failed — process may have already exited
      }
    } else {
      process.kill(pid, 'SIGKILL');
    }
  }

  async run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (child.pid) {
            this.killProcess(child.pid);
          }
          reject(new Error(`Process timeout after ${timeoutMs}ms: ${command}`));
        }
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (code !== 0) {
            logger.error({ command, args, code, stderr }, 'process failed');
            reject(new Error(stderr || `Process exited with code ${code}`));
            return;
          }
          resolve({ stdout, stderr });
        }
      });
    });
  }
}