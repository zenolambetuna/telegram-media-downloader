// Backward-compatible re-export. The Telegram Storage Engine now lives in
// TelegramStorage and its collaborators. This shim keeps older imports valid.
export { TelegramStorage } from './TelegramStorage';
export { UploadManager } from './UploadManager';
export { MessageManager } from './MessageManager';
export { MediaSender } from './MediaSender';
export { FileCache } from './FileCache';
export { ThumbnailUploader } from './ThumbnailUploader';
