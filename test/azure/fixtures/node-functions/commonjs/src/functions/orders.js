const { app, output } = require('@azure/functions');
const { ServiceBusClient } = require('@azure/service-bus');

const client = new ServiceBusClient('Endpoint=sb://contoso-cjs.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=CANARY-CJS-SHARED-ACCESS-KEY-0001');
const sender = client.createSender('orders-audit');

const queueOutput = output.storageQueue({ queueName: 'orders-out', connection: 'StorageConnection' });

async function createOrder(request, context) {
  context.log('creating order', request.url);
  await sender.sendMessages({ body: { id: 'x' } });
  return { status: 201 };
}

app.http('CreateOrder', { methods: ['POST'], authLevel: 'function', route: 'orders', extraOutputs: [queueOutput], handler: createOrder });

app.serviceBusQueue('ProcessOrder', {
  queueName: 'orders',
  connection: 'ServiceBus',
  handler: async (message, context) => {
    context.log('processing', message);
  },
});
