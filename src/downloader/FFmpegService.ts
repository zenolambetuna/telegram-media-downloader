--- a/src/downloader/FFmpegService.ts
+++ b/src/downloader/FFmpegService.ts
@@ -15,15 +15,43 @@ export class FFmpegService {
   constructor(private readonly processRunner: ProcessRunner) {}
 
   async mergeTracks(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
+    logger.info({ videoPath, audioPath, outputPath },
