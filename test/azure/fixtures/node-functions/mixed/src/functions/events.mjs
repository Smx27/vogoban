import { app } from '@azure/functions';

export async function onEvent(event, context) {
  context.log('event', event.type);
}

app.eventGrid('OnCatalogEvent', { handler: onEvent });
