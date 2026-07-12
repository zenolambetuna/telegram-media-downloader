import { spawn } from 'node:child_process';
import { logger } from '../logger/logger';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class ProcessRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`process timeout after ${timeoutMs}ms`));
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
            logger.error({ command, args, code, stderr }, 'child process failed');
            reject(new Error(stderr || `process exited with code ${code}`));
            return;
          }
          resolve({ stdout, stderr });
        }
      });
    });
  }
}
