--- a/src/core/MediaInspector.ts
+++ b/src/core/MediaInspector.ts
@@ -1,16 +1,16 @@
 import { ProviderRegistry } from './ProviderRegistry';
 import { DownloadEngine } from '../downloader/DownloadEngine';
-import { EngineMetadata } from '../types/download';
+import { ResolvedMediaInfo } from '../types/media';
 
 /**
  * MediaInspector resolves the provider for a URL and delegates all metadata
  * work to the Universal Download Engine.
  */
 export class MediaInspector {
   constructor(
     private readonly providerRegistry: ProviderRegistry,
     private readonly downloadEngine: DownloadEngine,
   ) {}
 
-  async inspect(url: string): Promise<EngineMetadata> {
+  async inspect(url: string): Promise<ResolvedMediaInfo> {
     const platform = this.providerRegistry.platformFor(url);
     return await this.downloadEngine.inspect(url, platform);
   }
 }
