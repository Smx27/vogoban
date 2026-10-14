using System.Collections.Concurrent;
using System.Text.Json;
using Json.Schema;
using Vg.Enterprise.Contracts.Topology;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Vg.Enterprise.Orders.Contracts;

public sealed class ContractSchemaOptions
{
    public const string SectionName = "Contracts";

    public string SchemaRoot { get; set; } = "../enterprise-contracts/contracts";
}

public interface IContractSchemaValidator
{
    void Validate<TContract>(string contractId, TContract contract);
}

/// <summary>
/// Validates event payloads against the JSON Schemas published by the
/// enterprise-contracts repository. The schema root is configuration, so the same
/// contract id resolves to the same file from every repository.
/// </summary>
public sealed class ContractSchemaValidator : IContractSchemaValidator
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<string, JsonSchema> _schemas = new();
    private readonly string _schemaRoot;

    public ContractSchemaValidator(
        IOptions<ContractSchemaOptions> options,
        ILogger<ContractSchemaValidator> logger)
    {
        _schemaRoot = Path.GetFullPath(options.Value.SchemaRoot, Directory.GetCurrentDirectory());
        logger.LogInformation("Contract schemas are loaded from {SchemaRoot}.", _schemaRoot);
    }

    public void Validate<TContract>(string contractId, TContract contract)
    {
        var schema = _schemas.GetOrAdd(contractId, Load);
        var instance = JsonSerializer.SerializeToElement(contract, typeof(TContract), SerializerOptions);

        var results = schema.Evaluate(instance, new EvaluationOptions { OutputFormat = OutputFormat.List });

        if (!results.IsValid)
        {
            throw new ContractValidationException(contractId, JsonSerializer.Serialize(results));
        }
    }

    private JsonSchema Load(string contractId)
    {
        var path = Path.Combine(_schemaRoot, contractId.Replace('/', Path.DirectorySeparatorChar) + ".schema.json");

        if (!File.Exists(path))
        {
            throw new ContractValidationException(contractId, $"No schema found at {path}.");
        }

        return JsonSchema.FromText(File.ReadAllText(path));
    }
}

public sealed class ContractValidationException : Exception
{
    public ContractValidationException(string contractId, string details)
        : base($"Contract '{contractId}' failed validation: {details}")
    {
        ContractId = contractId;
    }

    public string ContractId { get; }
}
