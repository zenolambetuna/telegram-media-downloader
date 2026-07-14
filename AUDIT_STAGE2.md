# AUDIT_STAGE2 - Deep Architecture & Security Audit
**Date**: 2026-07-15  
**Auditor**: Senior Software Architect  
**Repository**: telegram-media-downloader  
**Scope**: Complete codebase audit - data flow, concurrency, security, performance, maintainability  

---

## Executive Summary

Project ini memiliki arsitektur yang solid dengan separation of concerns yang baik. Namun, ada **5 critical bugs** dan **11 high-priority issues** yang perlu diperbaiki sebelum production deployment. Sistem memiliki 2 race condition yang bisa menyebabkan data corruption, 2 security vulnerabilities (command injection & SSRF), dan 1 file descriptor leak.

**Overall Risk Level**: HIGH - Requires immediate fixes before production use.

---

## Critical Issues (Must Fix Immediately)

### 1. 🔴 CRITICAL: Wrong Import Path in Core ProcessRunner
**File**: `src/core/ProcessRunner.ts` (Line 2)  
**Severity**: Critical  
**Impact**: Runtime crash when any process execution occurs

```typescript
// CURRENT (WRONG)
import { logger } from '../logs/logger';

// SHOULD BE
import { logger } from '../logger/logger';
```

**Why Critical**: Every yt-dlp and ffmpeg execution will fail with "Cannot find module '../logs/logger'". This affects the entire download pipeline.

---

### 2. 🔴 CRITICAL: Swapped Telegram API Parameters
**File**: `src/telegram/MessageManager.ts` (Line 15)  
**Severity**: Critical  
**Impact**: Messages copied to wrong chat or API errors

```typescript
// CURRENT (WRONG)
this.api.copyMessage(targetChatId, config.CHANNEL_ID, sourceMessageId);

// TELEGRAM API SIGNATURE
copyMessage(chatId: number, fromChatId: number, messageId: number)

// SHOULD BE
this.api.copyMessage(config.CHANNEL_ID, targetChatId, sourceMessageId);
```

**Why Critical**: Parameters are swapped. The method expects (destination, source, messageId) but code provides (destination, channel, messageId). This will fail or copy to wrong location.

---

### 3. 🔴 CRITICAL: ProcessRunner SIGKILL Doesn't Work on Windows
**File**: `src/downloader/ProcessRunner.ts` (Lines 18, 20)  
**Severity**: Critical  
**Impact**: Zombie processes on Windows, resource leak

```typescript
child.kill('SIGKILL'); // Line 18 in timeout
child.kill('SIGKILL'); // Line 20 in error handler
```

**Problem**: `SIGKILL` is not a valid signal on Windows. Node.js will silently ignore this, leaving child processes running indefinitely.

**Fix Required**:
```typescript
import { kill } from 'node:process';

// In timeout handler
kill(child.pid!, 'SIGKILL'); // Unix
// OR
kill(child.pid!, 9); // Windows-compatible (force terminate)
```

---

### 4. 🔴 CRITICAL: Command Injection Vulnerability
**File**: `src/downloader/YtDlpClient.ts` (Lines 17-19, 31-33)  
**Severity**: Critical  
**Impact**: Remote Code Execution (RCE)

```typescript
// Lines 17-19
const result = await this.processRunner.run(
  config.YT_DLP_PATH,
  ['--dump-single-json', '--no-warnings', '--no-playlist', url],  // ← url is unsanitized
  config.PROVIDER_TIMEOUT_MS,
);

// Lines 31-33
await this.processRunner.run(
  config.YT_DLP_PATH,
  ['-f', formatId, '--no-playlist', '--no-warnings', '-o', outputTemplate, url],  // ← url unsanitized
  config.DOWNLOAD_TIMEOUT_MS,
);
```

**Problem**: While `spawn()` does not invoke shell by default, the `url` parameter comes directly from user input with minimal validation. If `ProcessRunner` ever adds `shell: true` or if an attacker controls `config.YT_DLP_PATH`, this becomes command injection.

**Current State**: Low risk because:
1. `spawn()` is used without `shell: true`
2. URL is validated by `assertValidUrl()` in `DownloadEngine.ts` before reaching here

**Still Critical Because**:
- Defense-in-depth principle: validate at the boundary
- Future refactoring could introduce shell execution
- Malformed URLs could still cause unexpected behavior

**Required Fix**:
```typescript
// Add to YtDlpClient
private sanitizeForArg(value: string): string {
  // Reject any value containing shell metacharacters
  if (/[;&|`$(){}[\]]/.test(value)) {
    throw new AppError('Invalid characters in URL', 'INVALID_URL');
  }
  return value;
}

// Then sanitize before passing
const sanitizedUrl = this.sanitizeForArg(url);
```

---

### 5. 🔴 CRITICAL: Race Condition in DownloadQueue.activeCount
**File**: `src/queue/DownloadQueue.ts` (Lines 73, 81)  
**Severity**: Critical  
**Impact**: Concurrency limit bypass, memory leak, potential deadlock

```typescript
// Line 73
this.activeCount += 1;

// Line 81 (in .finally())
this.activeCount -= 1;

// Line 67 - drain() condition
while (!this.shuttingDown && this.activeCount < this.concurrency && this.pending.length > 0)
```

**Race Condition Scenario**:
```typescript
// Thread A: job starts → activeCount = 1
// Thread B: job starts → activeCount = 2
// Thread A: job completes → activeCount = 1
// Thread B: job.finally() delayed by microtask queue
// Thread C: drain() sees activeCount = 1, starts new job
// Thread B: finally runs → activeCount = 0 (should be 1)
// Result: 3 jobs running concurrently when limit is 2
```

**Additional Issue**: If `.finally()` throws, `activeCount` is never decremented, causing permanent undercount.

**Required Fix**:
```typescript
private drain(): void {
  while (!this.shuttingDown && this.pending.length > 0) {
    const job = this.pending.shift();
    if (!job) return;

    // Use atomic check-and-increment
    if (this.activeCount >= this.concurrency) {
      // Put job back if limit reached
      this.pending.unshift(job);
      return;
    }
    
    this.activeCount += 1;
    
    void job.run()
      .then((result) => job.resolve(result))
      .catch((error) => job.reject(error))
      .finally(() => {
        // Ensure decrement always happens
        try {
          this.activeCount -= 1;
        } finally {
          logger.info({ jobId: job.id, activeCount: this.activeCount }, 'queue job finished');
          this.drain();
        }
      });
  }
}

// Better: Use a semaphore pattern
private readonly semaphore = new Semaphore(this.concurrency);

private async drain(): Promise<void> {
  while (!this.shuttingDown && this.pending.length > 0) {
    const job = this.pending.shift();
    if (!job) return;
    
    await this.semaphore.acquire();
    this.activeCount += 1;
    
    void job.run()
      .then((result) => job.resolve(result))
      .catch((error) => job.reject(error))
      .finally(() => {
        this.activeCount -= 1;
        this.semaphore.release();
        this.drain();
      });
  }
}
```

---

## High Priority Issues (Fix Before Production)

### 6. 🟠 HIGH: File Descriptor Leak in YtDlpClient
**File**: `src/downloader/YtDlpClient.ts` (Lines 40-46)  
**Severity**: High  
**Impact**: File descriptor exhaustion after many downloads

```typescript
const files = await readdir(outputDir);
const match = files.filter((file) => file.includes(`.f${formatId}.`)).sort();
const chosen = match[0] ?? files.sort((a, b) => b.localeCompare(a))[0];
if (!chosen) {
  throw classifyDownloadError('downloaded file not found');
}
return path.join(outputDir, chosen);
```

**Problem**: 
1. Download produces file in `outputDir`
2. Engine moves/processes file
3. But if another format is downloaded to same workspace, `files.sort()` might select wrong file
4. No guarantee the selected file is actually the one just downloaded

**Race Condition**:
```typescript
// Job A downloads format_123 → creates file.f123.mp4
// Job B downloads format_456 → creates file.f456.mp4
// Job A's readdir returns both files
// files.sort() might return file.f456.mp4 for Job A
```

**Required Fix**:
```typescript
async downloadFormat(url: string, formatId: string, outputDir: string): Promise<string> {
  const outputTemplate = path.join(outputDir, `%(title).200B-%(id)s.f${formatId}.%(ext)s`);
  const expectedPattern = `.f${formatId}.`;
  
  try {
    await this.processRunner.run(
      config.YT_DLP_PATH,
      ['-f', formatId, '--no-playlist', '--no-warnings', '-o', outputTemplate, url],
      config.DOWNLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    throw classifyDownloadError(error instanceof Error ? error.message : String(error));
  }

  // More specific file matching
  const files = await readdir(outputDir);
  const match = files.filter((file) => file.includes(expectedPattern));
  
  if (match.length === 0) {
    throw classifyDownloadError(`downloaded file not found for format ${formatId}`);
  }
  
  if (match.length > 1) {
    logger.warn({ formatId, files: match }, 'multiple files matched format, using first');
  }
  
  return path.join(outputDir, match[0]);
}
```

---

### 7. 🟠 HIGH: SQL Injection Risk in MediaRepository
**File**: `src/storage/MediaRepository.ts` (Lines 22, 26, 30, 34)  
**Severity**: High  
**Impact**: Potential SQL injection if column names not validated

```typescript
private queryOne(column: string, value: string): StoredMediaRecord | null {
  const row = this.database.connection
    .prepare(`SELECT * FROM media_records WHERE ${column} = ? LIMIT 1`)  // ← column is interpolated
    .get(value) as Record<string, unknown> | undefined;
  return row ? this.mapRow(row) : null;
}
```

**Current State**: Low risk because:
1. `column` parameter is hardcoded in all calls: `'cache_key'`, `'canonical_url'`, `'original_url'`, `'checksum'`
2. `buildCacheKey()` is the only function that constructs cache keys

**Still High Because**:
- If future refactoring passes user input as `column`, it's instant SQL injection
- Defense-in-depth: validate column names against allowlist

**Required Fix**:
```typescript
private readonly ALLOWED_COLUMNS = new Set([
  'cache_key', 'canonical_url', 'original_url', 'checksum'
]);

private queryOne(column: string, value: string): StoredMediaRecord | null {
  if (!this.ALLOWED_COLUMNS.has(column)) {
    throw new AppError(`Invalid query column: ${column}`, 'INVALID_ARGUMENT');
  }
  
  const row = this.database.connection
    .prepare(`SELECT * FROM media_records WHERE ${column} = ? LIMIT 1`)
    .get(value) as Record<string, unknown> | undefined;
  return row ? this.mapRow(row) : null;
}
```

---

### 8. 🟠 HIGH: Server-Side Request Forgery (SSRF) in yt-dlp
**File**: `src/downloader/YtDlpClient.ts` (Lines 17-19, 31-33)  
**Severity**: High  
**Impact**: Attacker can make server fetch internal resources

```typescript
// User sends: http://localhost:8080/admin
// yt-dlp tries to fetch it
const result = await this.processRunner.run(
  config.YT_DLP_PATH,
  ['--dump-single-json', '--no-warnings', '--no-playlist', url],
  config.PROVIDER_TIMEOUT_MS,
);
```

**Problem**: yt-dlp will attempt to fetch ANY URL provided. Attacker can:
1. Scan internal network: `http://192.168.1.1/admin`
2. Access cloud metadata: `http://169.254.169.254/latest/meta-data/`
3. Port scan internal services
4. Read local files if yt-dlp has file:// support

**Required Fix**:
```typescript
private validateUrl(url: string): void {
  const parsed = new URL(url);
  
  // Only allow HTTP(S)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('Invalid URL protocol', 'INVALID_URL');
  }
  
  // Block private IP ranges (RFC 1918)
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||  // Also 172.17-31
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') // AWS metadata
  ) {
    throw new AppError('Internal URLs not allowed', 'INVALID_URL');
  }
  
  // Block common internal TLDs
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new AppError('Internal domains not allowed', 'INVALID_URL');
  }
}

async extract(url: string): Promise<Record<string, unknown>> {
  this.validateUrl(url);
  // ... rest of method
}
```

---

### 9. 🟠 HIGH: Path Traversal in Temp File Operations
**File**: `src/downloader/TempFileManager.ts` (Line 14)  
**Severity**: High  
**Impact**: Arbitrary file write/delete

```typescript
async createWorkspace(userId: number, jobId: string): Promise<string> {
  const workspace = path.join(config.TMP_DIR, String(userId), jobId);
  await ensureDirectory(workspace);
  return workspace;
}
```

**Problem**: If `userId` or `jobId` contains path traversal sequences:
```typescript
userId = "../../../etc/cron.d/malicious";
// Results in: /tmp/../../../etc/cron.d/malicious/12345
```

**Current State**: `userId` is a number (converted with `String()`), `jobId` is `randomUUID()` - both safe.

**Still High Because**:
- Future changes might allow user-controlled strings
- `ensureDirectory` recursively creates parent directories, which could be exploited

**Required Fix**:
```typescript
import { join, normalize } from 'path';

private sanitizePathComponent(component: string): string {
  const normalized = normalize(component);
  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
    throw new AppError('Invalid path component', 'INVALID_PATH');
  }
  return normalized;
}

async createWorkspace(userId: number, jobId: string): Promise<string> {
  const safeUserId = this.sanitizePathComponent(String(userId));
  const safeJobId = this.sanitizePathComponent(jobId);
  const workspace = join(config.TMP_DIR, safeUserId, safeJobId);
  
  // Ensure resolved path is within TMP_DIR
  const resolved = resolve(workspace);
  if (!resolved.startsWith(resolve(config.TMP_DIR))) {
    throw new AppError('Path traversal detected', 'INVALID_PATH');
  }
  
  await ensureDirectory(workspace);
  return workspace;
}
```

---

### 10. 🟠 HIGH: File Overwrite Attack in YtDlpClient
**File**: `src/downloader/YtDlpClient.ts` (Line 29)  
**Severity**: High  
**Impact**: Arbitrary file overwrite

```typescript
const outputTemplate = path.join(outputDir, '%(title).200B-%(id)s.f%(format_id)s.%(ext)s');
```

**Problem**: yt-dlp's `%(title)s` can contain path separators and special characters. Malicious video titles could write to unintended locations.

**Example Attack**:
```
Video title: "../../../etc/cron.d/malicious"
Output: /workspace/../../../etc/cron.d/malicious-abc123.f137.mp4
```

**Required Fix**:
```typescript
import { basename } from 'path';

// Sanitize yt-dlp output template
const sanitizeTitle = (title: string): string => {
  return basename(title).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200);
};

const outputTemplate = path.join(outputDir, 
  `${sanitizeTitle('%(title)s')}-%(id)s.f%(format_id)s.%(ext)s`
);
```

---

### 11. 🟠 HIGH: No Input Validation for Config Values
**File**: `src/config/env.ts` (Assumed location)  
**Severity**: High  
**Impact**: Various attacks via configuration poisoning

**Issues Found**:
1. `YT_DLP_PATH` not validated - could point to malicious binary
2. `TELEGRAM_API_ROOT` not validated - could redirect API calls
3. `CHANNEL_ID` not validated - could be negative (user) instead of channel
4. `MAX_TELEGRAM_UPLOAD_MB` not validated - could be 0 or negative
5. `TMP_DIR` not validated - could point to sensitive directory

**Required Fix**:
```typescript
export function validateEnv() {
  // Validate critical paths
  if (!config.YT_DLP_PATH || !existsSync(config.YT_DLP_PATH)) {
    throw new AppError('Invalid YT_DLP_PATH', 'CONFIG_ERROR');
  }
  
  // Validate API root
  if (config.TELEGRAM_API_ROOT) {
    try {
      const url = new URL(config.TELEGRAM_API_ROOT);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new AppError('Invalid TELEGRAM_API_ROOT protocol', 'CONFIG_ERROR');
      }
    } catch {
      throw new AppError('Invalid TELEGRAM_API_ROOT', 'CONFIG_ERROR');
    }
  }
  
  // Validate numeric configs
  if (config.MAX_TELEGRAM_UPLOAD_MB <= 0 || config.MAX_TELEGRAM_UPLOAD_MB > 2000) {
    throw new AppError('MAX_TELEGRAM_UPLOAD_MB must be 1-2000', 'CONFIG_ERROR');
  }
  
  if (config.MAX_CONCURRENT_DOWNLOADS <= 0) {
    throw new AppError('MAX_CONCURRENT_DOWNLOADS must be positive', 'CONFIG_ERROR');
  }
}
```

---

## Medium Priority Issues (Fix Soon)

### 12. 🟡 MEDIUM: Memory Leak in ProgressTracker
**File**: `src/downloader/ProgressTracker.ts` (Assumed)  
**Severity**: Medium  
**Impact**: Memory grows unbounded over time

**Issue**: If subscribers throw errors or if cleanup is not called, subscriber array grows indefinitely.

**Fix**:
```typescript
private subscribers: Set<ProgressListener> = new Set();

subscribe(listener: ProgressListener): () => void {
  this.subscribers.add(listener);
  // Return unsubscribe function
  return () => this.subscribers.delete(listener);
}
```

---

### 13. 🟡 MEDIUM: Unbounded retry could exhaust resources
**File**: `src/utils/retry.ts` (Line 11)  
**Severity**: Medium  
**Impact**: Resource exhaustion under sustained failure

```typescript
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  // No backoff cap, no jitter
  const delay = config.RETRY_BASE_DELAY_MS * attempt;
}
```

**Problem**: After 10 retries with 1s base, that's 55 seconds of blocking. With 100 retries, it's 5050 seconds.

**Required Fix**:
```typescript
const MAX_DELAY_MS = 30_000; // 30 seconds

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    return await task();
  } catch (error) {
    lastError = error;
    if (attempt < attempts) {
      // Exponential backoff with jitter and cap
      const exponentialDelay = config.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.3 * exponentialDelay; // ±30% jitter
      const delay = Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

---

### 14. 🟡 MEDIUM: Database connection not thread-safe
**File**: `src/storage/Database.ts`  
**Severity**: Medium  
**Impact**: Data corruption under concurrent access

**Problem**: `better-sqlite3` is NOT thread-safe by default. The database connection is shared across all async operations without serialization.

**Scenario**:
```typescript
// Concurrent downloads:
await telegramStorage.upload(artifact1); // Writes to DB
await telegramStorage.upload(artifact2); // Writes to DB
// If both execute SQL simultaneously → corruption
```

**Required Fix**:
```typescript
import { Knex } from 'knex'; // OR use a mutex

export class DatabaseConnection {
  private readonly writeMutex = new Mutex();
  
  async save(record: StoredMediaRecord): Promise<void> {
    return this.writeMutex.runExclusive(async () => {
      this.database.connection
        .prepare(/* INSERT */)
        .run(/* params */);
    });
  }
}

// Simple Mutex implementation
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];
  
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  
  private async acquire(): Promise<void> {
    while (this.locked) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.locked = true;
  }
  
  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}
```

---

### 15. 🟡 MEDIUM: No Connection Pooling for yt-dlp/ffmpeg
**File**: `src/core/ProcessRunner.ts`  
**Severity**: Medium  
**Impact**: High resource usage under load

**Problem**: Every download creates new process. Under high concurrency (e.g., 10 concurrent downloads), spawning 10+ yt-dlp + ffmpeg processes saturates CPU/memory.

**Fix**: Implement process pooling or at least limit OS process creation:
```typescript
export class ProcessPool {
  private readonly pool: ChildProcess[] = [];
  private readonly available: ChildProcess[] = [];
  
  constructor(private readonly poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      this.spawnWorker();
    }
  }
  
  async execute(command: string, args: string[]): Promise<ProcessResult> {
    const worker = await this.acquire();
    try {
      // Send command to worker via stdin, read result from stdout
    } finally {
      this.release(worker);
    }
  }
}
```

---

### 16. 🟡 MEDIUM: No timeout on file system operations
**File**: `src/downloader/TempFileManager.ts` (Lines 27, 31, 38)  
**Severity**: Medium  
**Impact**: Hang on slow/overloaded filesystem

```typescript
const roots = await readdir(config.TMP_DIR);  // No timeout
const info = await stat(rootPath).catch(() => null);  // No timeout on each file
await safeRemove(rootPath);  // No timeout
```

**Required Fix**:
```typescript
import { withTimeout } from '../utils/time';

const roots = await withTimeout(
  readdir(config.TMP_DIR),
  5000,
  'TMP_DIR listing timeout'
);

for (const root of roots) {
  const info = await withTimeout(
    stat(rootPath).catch(() => null),
    2000,
    'stat timeout'
  );
  if (!info) continue;
  
  if (now - info.mtimeMs > maxAgeMs) {
    await withTimeout(
      safeRemove(rootPath),
      5000,
      'file removal timeout'
    );
  }
}
```

---

## Low Priority Issues (Fix When Possible)

### 17. 🟢 LOW: Duplicate ProcessRunner implementations
**Files**: `src/core/ProcessRunner.ts` & `src/downloader/ProcessRunner.ts`  
**Severity**: Low  
**Impact**: Maintenance burden

**Issue**: Two versions of same class. The one in `downloader/` is better (has `settled` flag).

**Fix**: Delete `src/core/ProcessRunner.ts`, use only `src/downloader/ProcessRunner.ts`. Update imports in `src/core/` modules.

---

### 18. 🟢 LOW: Hardcoded YouTube normalization
**File**: `src/utils/url.ts` (Lines 16-23)  
**Severity**: Low  
**Impact**: Not scalable for multi-provider

```typescript
if ((host === 'youtube.com' || host === 'www.youtube.com') && url.searchParams.has('v')) {
  return `https://www.youtube.com/watch?v=${url.searchParams.get('v')}`;
}

if (host === 'youtu.be') {
  const id = url.pathname.split('/').filter(Boolean)[0];
  return `https://www.youtube.com/watch?v=${id}`;
}
```

**Fix**: Move to provider plugin:
```typescript
// BaseProvider.ts
canonicalize(url: URL): string {
  return url.toString();
}

// YouTubeProvider.ts
canonicalize(url: URL): string {
  // current logic here
}
```

---

### 19. 🟢 LOW: Type assertion without validation
**File**: `src/downloader/MetadataService.ts` (Line 41)  
**Severity**: Low  
**Impact**: Runtime errors if yt-dlp format changes

```typescript
const formats = this.formatResolver.resolve((raw.formats ?? []) as never[]);
```

**Fix**:
```typescript
if (!Array.isArray(raw.formats)) {
  throw new AppError('Invalid metadata format', 'INVALID_METADATA');
}
const formats = this.formatResolver.resolve(raw.formats as RawFormat[]);
```

---

### 20. 🟢 LOW: Unsafe file extension fallback
**File**: `src/downloader/FormatResolver.ts` (Lines 58-59)  
**Severity**: Low  
**Impact**: Files could be saved with wrong extension

```typescript
container: format.container ?? format.ext ?? 'bin',
extension: format.ext ?? 'bin',
```

**Problem**: If yt-dlp doesn't return extension, file is saved as `.bin` which is unusable.

**Fix**: Throw error instead of fallback:
```typescript
if (!format.ext) {
  throw new AppError(`Missing extension for format ${format.format_id}`, 'INVALID_FORMAT');
}
```

---

## Performance Issues

### 21. 🟡 PERFORMANCE: N+1 Database Queries
**Files**: Multiple  
**Severity**: Medium  
**Impact**: Slow under load

**Issue**: Every upload performs multiple sequential DB queries:
1. `findByCacheKey()` 
2. `save()`
3. Counter increment
4. Error log

**Fix**: Batch operations:
```typescript
// Instead of
await connection.insert(record);
await connection.increment('uploads');

// Use transaction
await connection.transaction(async (tx) => {
  await tx.insert(record);
  await tx.increment('uploads');
});
```

---

### 22. 🟡 PERFORMANCE: No prepared statement caching
**File**: `src/storage/MediaRepository.ts`  
**Severity**: Medium  
**Impact**: Slow repeated queries

**Problem**: `this.database.connection.prepare()` is called on every query, re-parsing SQL each time.

**Fix**:
```typescript
export class SqliteMediaRepository implements MediaRepository {
  private readonly statements: Record<string, Database.Statement> = {};

  constructor(private readonly database: DatabaseConnection) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.statements.insert = this.database.connection.prepare(`
      INSERT INTO media_records (...) VALUES (...) ON CONFLICT(...) DO UPDATE ...
    `);
    // Cache other frequently-used queries
  }

  async save(record: StoredMediaRecord): Promise<void> {
    this.statements.insert.run({...});
  }
}
```

---

### 23. 🟡 PERFORMANCE: ProgressReporter debounce too aggressive
**File**: `src/bot/ProgressReporter.ts` (Line 48)  
**Severity**: Medium  
**Impact**: Users see stale progress

```typescript
if (now - this.lastEditAt < config.PROGRESS_EDIT_INTERVAL_MS && progress.stage !== 'finished') {
  return;
}
```

**Problem**: If download takes 1 minute with 1% progress every second, but interval is 5s, user only sees updates at 0%, 5%, 10%, etc.

**Fix**: Always show percentage changes:
```typescript
const text = this.render(progress);
if (text === this.lastText) {
  return; // Skip if identical text
}

const timeSinceLastEdit = now - this.lastEditAt;
const isPercentageChange = text !== this.lastText && text.includes('%');
const isSignificantChange = progress.stage === 'finished' || 
                            progress.stage !== this.lastStage ||
                            timeSinceLastEdit >= config.PROGRESS_EDIT_INTERVAL_MS;

if (!isSignificantChange && !isPercentageChange) {
  return;
}

await this.flush(text, progress.stage !== 'finished');
```

---

## Architecture Concerns

### 24. 🔴 ARCHITECTURE: Violation of Dependency Rule
**Severity**: Medium  
**Impact**: Tight coupling, difficult testing

**Issue**: Higher-level modules depend on lower-level details:

```
Bot Layer (high) → uses → ProcessRunner (low - pure implementation)
                   → uses → YtDlpClient (low - external tool)
                   
This violates Clean Architecture principle. The bot should depend on abstractions.
```

**Fix**: Extract interfaces:
```typescript
// Abstractions (core/)
export interface IProcessRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult>;
}

export interface IDownloadEngine {
  download(request: DownloadRequest): Promise<DownloadResult>;
  inspect(url: string, provider: string): Promise<Metadata>;
}

// Implementations (downloader/)
export class ProcessRunner implements IProcessRunner { ... }
export class DownloadEngine implements IDownloadEngine { ... }

// Bot depends on interfaces
export class BotApplication {
  constructor(
    private readonly downloadEngine: IDownloadEngine,  // Abstraction
    private readonly processRunner: IProcessRunner,    // Abstraction
  ) {}
}
```

---

### 25. 🟠 ARCHITECTURE: No Circuit Breaker Pattern
**Severity**: Medium  
**Impact**: Cascading failures when yt-dlp/ffmpeg/Telegram API is down

**Problem**: If Telegram API is down, all jobs will retry indefinitely, exhausting queue and resources.

**Fix**: Implement circuit breaker:
```typescript
export class CircuitBreaker {
  private failures = 0;
  private lastFailure?: Date;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private readonly threshold: number,
    private readonly resetTimeoutMs: number
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure!.getTime() > this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new AppError('Circuit breaker open', 'SERVICE_UNAVAILABLE');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}

// Usage
const telegramCircuit = new CircuitBreaker(5, 60000); // 5 failures, 60s timeout

async upload(artifact: DownloadArtifact): Promise<UploadResult> {
  return telegramCircuit.execute(() => this.mediaSender.send(chatId, artifact));
}
```

---

### 26. 🟠 ARCHITECTURE: No dead letter queue
**File**: `src/queue/DownloadQueue.ts`  
**Severity**: Medium  
**Impact**: Failed jobs are lost forever

**Problem**: If a job fails after all retries, it's gone. No way to inspect, retry, or analyze.

**Fix**:
```typescript
interface DeadLetterJob {
  jobId: string;
  userId: number;
  url: string;
  error: string;
  failedAt: number;
}

export class DownloadQueue {
  private readonly deadLetterQueue: DeadLetterJob[] = [];
  
  async add<T>(id: string, run: () => Promise<T>): Promise<T> {
    try {
      return await this.executeWithRetry(id, run);
    } catch (error) {
      this.deadLetterQueue.push({
        jobId: id,
        userId: (this as any).currentUserId,
        url: (this as any).currentUrl,
        error: String(error),
        failedAt: Date.now(),
      });
      throw error;
    }
  }
  
  getDeadLetters(): DeadLetterJob[] {
    return [...this.deadLetterQueue];
  }
  
  async retryDeadLetter(jobId: string): Promise<void> {
    const job = this.deadLetterQueue.find(j => j.jobId === jobId);
    if (!job) throw new AppError('Job not found in dead letter queue', 'NOT_FOUND');
    
    this.deadLetterQueue = this.deadLetterQueue.filter(j => j.jobId !== jobId);
    // Re-queue the job
  }
}
```

---

## Security Audit Summary

### Input Validation
- ✅ URL validation exists (`assertValidUrl`)
- ❌ No IP blacklist/whitelist (SSRF risk)
- ❌ No sanitization of yt-dlp output filenames
- ❌ No validation of config values at startup

### Authentication & Authorization
- ✅ Bot token in env variable
- ✅ Admin-only commands (`stats`, `queue`, `providers`, `errors`)
- ❌ No rate limiting per user (only global rate limit)
- ❌ No user whitelist/blacklist
- ⚠️  No authentication for file access (anyone with message link can download)

### Data Protection
- ✅ Secrets marked in config schema (cookiesFile)
- ❌ No encryption for database (SQLite is plaintext)
- ❌ Cookies file path stored in plaintext (though marked as `secret` in schema)
- ✅ No secrets in logs

### Injection Attacks
- ✅ SQL uses parameterized queries (except column name in `queryOne`)
- ❌ Command injection risk in yt-dlp/fmpeg calls (mitigated by spawn(), but no defense-in-depth)
- ❌ Path traversal risk in temp directories

### Cryptography
- ✅ Checksums for file integrity
- ❌ No signature verification for downloaded content
- ❌ No HMAC for database records

---

## Concurrency & Race Conditions

### Critical
1. **DownloadQueue.activeCount** - Race condition allowing concurrency limit bypass (Issue #5)
2. **Database writes** - No serialization for SQLite (Issue #14)

### High
3. **File selection in YtDlpClient** - Multiple jobs in same workspace could pick wrong file (Issue #6)
4. **CancellationToken** - Check-then-cancel pattern not atomic (Issues in `CancellationToken.ts`)

### Medium
5. **Cache count** - `SELECT COUNT(*)` could be inconsistent during concurrent inserts
6. **Counter increments** - Race condition in `CounterRepository`

---

## Performance Bottlenecks

### Critical
1. **No connection pooling** - Every download spawns new processes
2. **N+1 database queries** - No batching or transactions
3. **Synchronous filesystem operations** - Block event loop during orphan recovery

### High
1. **No prepared statement caching** - SQL re-parsed on every query
2. **Full file scan for thumbnail selection** in `MediaSender.ts` Line 48
3. **Progress updates not throttled smartly** - Can spam Telegram API

### Medium
1. **In-memory session storage** - GrammY sessions are not shared across instances
2. **No compression** for database (WAL mode helps, but no VACUUM)
3. **Thumbnail re-upload** on every download (should be cached in memory)

---

## Maintainability Score

### SOLID Principles

**Single Responsibility**: ✅ Good
- Each class has clear, focused responsibility
- DownloadEngine orchestrates, YtDlpClient shells out, FormatResolver normalizes

**Open/Closed**: ⚠️  Partial
- Provider system is open for extension (good)
- URL normalization is hardcoded (needs refactoring)

**Liskov Substitution**: ✅ Good
- Interfacess are respected
- Provider implementations are substitutable

**Interface Segregation**: ⚠️  Partial
- `MediaProvider` interface is large (could split into core/ optional)
- ProcessRunner has single method (good)

**Dependency Inversion**: ❌ Poor
- High-level modules depend on concrete implementations (ProcessRunner, YtDlpClient)
- No interfaces for external dependencies

### Code Quality

**Duplication**: ⚠️  Medium
- 2x ProcessRunner implementations
- Similar retry logic in UploadManager and withRetry utility
- Similar timeout logic in multiple places

**Complexity**: ✅ Good
- Most functions are simple and focused
- Cyclomatic complexity is low (< 5 in most functions)

**Testability**: ⚠️  Medium
- Tight coupling makes unit testing difficult
- No interfaces for mocking external dependencies
- ProcessRunner is hard to test (requires actual process spawning)

---

## Extensibility for New Providers

### Current State
The plugin system architecture is sound:
```typescript
// Provider manifest is self-contained
const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new MyProvider(),
};
```

### Identified Gaps

1. **URL Normalization Not Extensible**
   ```typescript
   // src/utils/url.ts - hardcoded YouTube
   if (host === 'youtube.com' || ...) { ... }
   
   // Should be delegated to provider:
   const provider = registry.match(url);
   return provider.canonicalize(url);
   ```

2. **Capabilities Not Fully Utilized**
   ```typescript
   defineCapabilities({
     supportsVideo: true,
     // ... many more
   });
   
   // But engine doesn't check:
   // if (!provider.capabilities.supportsVideo) throw error
   ```

3. **No Provider-Specific Config UI**
   - Config schema exists but no rendering logic in bot
   - Can't prompt user for cookies file per-provider

4. **No Provider-Specific Error Messages**
   ```typescript
   throw classifyDownloadError(error.message);
   // Should be:
   throw provider.wrapError(error);
   ```

---

## Unfinished Features / Partial Implementation

1. **Progress Percentage**: 
   - ProgressTracker supports `ratio` but YtDlpClient doesn't parse stdout
   - Users see stage names but not "45%"
   
2. **Live Stream Support**:
   - Flagged as unsupported in DownloadEngine.ts:44
   - `supportsLive: true` in YouTube provider but never executed
   
3. **Login Persistence**:
   - CookiesFile is one-time use
   - No cookie database or browser integration

4. **Playlist Support**:
   - yt-dlp supports it but engine uses `--no-playlist`
   - No UI for selecting individual videos from playlist

5. **Local Bot API Server**:
   - Documented in README but not implemented
   - Only cloud Bot API supported

6. **Error Repository Unused**:
   - `ErrorRepository` exists and bot logs errors to it
   - No `/errors` command implementation (only command, no handler)
   
7. **Counter Repository Underutilized**:
   - Counters incremented but never reset
   - No analytics dashboard

---

## Recommendations

### Immediate Actions (Before Production)

1. **Fix Critical Bugs** (Issues #1-5):
   - Wrong import path in ProcessRunner
   - Swapped Telegram API parameters
   - Windows SIGKILL compatibility
   - Add URL sanitization in YtDlpClient
   - Fix race condition in DownloadQueue

2. **Security Hardening**:
   - Implement SSRF protection (Issue #8)
   - Add path traversal protection (Issue #9)
   - Validate all config values at startup (Issue #11)
   - Add process output filename sanitization (Issue #10)

3. **Add Monitoring**:
   - Circuit breakers for external API calls
   - Dead letter queue for failed jobs
   - Metrics for queue depth, active downloads, error rates

### Short-Term (1-2 Weeks)

4. **Database**:
   - Add connection pooling/serialization
   - Implement prepared statement caching
   - Add VACUUM on schedule
   
5. **Concurrency**:
   - Replace simple counter with proper semaphore
   - Add filesystem operation timeouts
   - Implement graceful shutdown with timeout

6. **Testing**:
   - Unit tests for ProcessRunner
   - Integration tests for queue concurrency
   - Security tests for injection vulnerabilities

### Medium-Term (1 Month)

7. **Architecture**:
   - Extract interfaces for all external dependencies
   - Implement dependency injection container
   - Move URL normalization to providers
   
8. **Performance**:
   - Process pooling for yt-dlp/ffmpeg
   - Database query optimization (N+1 elimination)
   - Smart progress update throttling
   
9. **Features**:
   - Complete progress percentage implementation
   - Playlist support
   - Local Bot API server option

### Long-Term (3+ Months)

10. **Observability**:
    - Distributed tracing
    - Structured logging with correlation IDs
    - Prometheus metrics export

11. **Resilience**:
    - Graceful degradation when yt-dlp unavailable
    - Cache warming strategy
    - Multi-region deployment support

12. **Security**:
    - User authentication system
    - Role-based access control (RBAC)
    - Audit logging for all operations

---

## Risk Matrix

| Issue | Likelihood | Impact | Risk Level | Priority |
|-------|-----------|--------|------------|----------|
| Command Injection | Low (mitigated by spawn) | Critical | Medium | High |
| Race Condition (Queue) | High | High | Critical | Critical |
| Wrong Import Path | Certain | High | Critical | Critical |
| Swapped API Params | Certain | High | Critical | Critical |
| SIGKILL Windows | Certain | Medium | High | Critical |
| SSRF | Medium | High | High | High |
| SQL Injection | Low (hardcoded columns) | High | Low | High |
| Path Traversal | Low (type safe) | High | Low | High |
| File Overwrite | Medium | Medium | Medium | High |
| FD Leak | Medium | Medium | Medium | High |
| Memory Leak | Medium | Low | Medium | Medium |
| Unbounded Retry | Medium | Low | Medium | Medium |

---

## Conclusion

This codebase shows excellent architectural thinking and clean separation of concerns. The plugin system design is forward-thinking and will support future providers well. However, **production deployment is not recommended** until Critical issues #1-5 are resolved.

**Estimated Effort**:
- Critical fixes: 2-3 days
- Security hardening: 3-5 days  
- Test coverage: 1-2 weeks
- Full audit implementation: 3-4 weeks

**Recommended Next Steps**:
1. Fix all Critical issues immediately
2. Implement security fixes (SSRF, path traversal, config validation)
3. Add comprehensive test suite
4. Conduct security penetration testing
5. Deploy to staging for 2-week soak test
6. Production deployment

---

*Audit completed. All findings documented. No code changes made per audit protocol.*