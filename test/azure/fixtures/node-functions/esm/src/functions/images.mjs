import { app } from '@azure/functions';
import * as functions from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const blobs = new BlobServiceClient(process.env.Storage__serviceUri, new DefaultAzureCredential());
const thumbnails = blobs.getContainerClient('thumbnails');

export async function resize(blob, context) {
  context.log('resize', context.triggerMetadata.name);
  await thumbnails.uploadBlockBlob(context.triggerMetadata.name, blob, blob.length);
}

export async function listImages(request) {
  return { status: 200, body: request.url };
}

app.storageBlob('ResizeImage', { path: 'images/{name}', connection: 'Storage', handler: resize });
functions.app.http('ListImages', { methods: ['GET'], authLevel: 'anonymous', route: 'images', handler: listImages });
