const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const cosmos = new CosmosClient('AccountEndpoint=https://cosmos-mixed.documents.azure.com:443/;AccountKey=CANARY-COSMOS-ACCOUNT-KEY-0002==;');
const products = cosmos.database('catalogdb').container('products');

app.http('GetProduct', {
  methods: ['GET'],
  route: 'products/{id}',
  handler: async (request) => {
    const { resource } = await products.item(request.params.id, request.params.id).read();
    return { jsonBody: resource };
  },
});
