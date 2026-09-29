export interface GcsPresignGetOptions {
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface GcsPresignPutOptions {
  expiresIn: number;
  contentType: string;
  contentLength: number;
}
