import { spawn } from 'node:child_process';
import { logger } from '../logger/logger';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class ProcessRunner {
  async run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Process timeout after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.error({ command, args, code, stderr }, 'process failed');
          reject(new Error(stderr || `Process exited with code ${code}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
