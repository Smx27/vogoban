using Azure;
using Azure.Identity;
using Azure.Messaging.ServiceBus;

namespace App;

public static class Program
{
    public const string ServiceBusConnection = "Endpoint=sb://contoso-orders.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=CANARYSBKEY0123456789abcdefghijklmnopqrstuv=";
    public const string StorageConnection = "DefaultEndpointsProtocol=https;AccountName=stcontoso;AccountKey=CANARYSTORAGEKEY0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV==;EndpointSuffix=core.windows.net";
    public const string CosmosConnection = "AccountEndpoint=https://contoso.documents.azure.com:443/;AccountKey=CANARYCOSMOSKEY0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV==;";
    public const string SasUrl = "https://stcontoso.blob.core.windows.net/orders?sv=2022-11-02&ss=b&sig=CANARYSIGNATURE0123456789&se=2030-01-01";
    public const string FunctionUrl = "https://orders-fn.azurewebsites.net/api/orders?code=CANARYFUNCTIONKEY0123456789";
    public const string SasToken = "sv=2022-11-02&ss=b&srt=sco&sp=rwdlac&sig=CANARYSASTOKEN0123456789";
    public const string AppConfig = "Endpoint=https://contoso.azconfig.io;Id=abc-l0-s0:XYZ;Secret=CANARYAPPCONFIGSECRET";

    public static async Task Main()
    {
        var named = new AzureNamedKeyCredential("orders-policy", "CANARYNAMEDKEYLETTERS");
        var key = new AzureKeyCredential("CANARYKEYSHORT");
        var secret = new ClientSecretCredential("tenant-id", "client-id", "abc8Q~CANARYCLIENTSECRET.0123456789abcdefg");
        var sas = new AzureSasCredential("sig=CANARYSASCREDENTIAL");
        var client = new ServiceBusClient(ServiceBusConnection);
        var direct = new ServiceBusClient("Endpoint=sb://contoso-inline.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=CANARYINLINEKEY0123456789abcdefghijklmnopq=");
        var cosmos = new Microsoft.Azure.Cosmos.CosmosClient("https://contoso.documents.azure.com:443/", "CANARYCOSMOSAUTHKEY0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==");
        var sender = client.CreateSender("orders");
        await sender.SendMessageAsync(new ServiceBusMessage(Nested.Settings.Describe(named, key, secret, sas, direct, cosmos)));
    }
}
